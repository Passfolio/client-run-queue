import Heap from 'heap';

import { runAfterInteractions } from '../config/run-after-interactions';
import { getStatsHandler } from '../config/stats-handler';
import { CANCELED } from './consts';
import { DEFAULT_CONTINUOUS_WORK_TIME_LIMIT_MSEC, DEFAULT_MAX_PARALLEL } from './internal/consts';
import type { RunQueueEntry, RunQueueEntryResult } from './types/entry';
import { RunQueueOptions } from './types/options';
import { RunQueueScheduleOptions } from './types/schedule-options';

interface InternalRunQueueEntry<T = any> {
  /** A technical but human-readable ID of the entry */
  id: string;
  /** Lower number is higher priority */
  priority: number;
  /** If `true`, this entry can't be canceled */
  neverCancel: boolean;

  /** If `true`, this entry was canceled */
  wasCanceled: boolean;
  /** If `true`, this entry was completed */
  wasCompleted: boolean;
  /** If `true`, this entry was started */
  wasStarted: boolean;

  /** Tries to cancel this entry */
  cancel: () => boolean;
  /** Called if an error occurred while running this entry */
  reject: (e: any) => void;
  /** Called when this entry is completed */
  resolve: (value: T) => void;
  /** Runs this entry */
  run: () => Promise<T> | T;
}

const placeholderCancel = () => false;
const placeholderResolve = () => {};
const placeholderReject = () => {};

export class RunQueue {
  // Public Readonly Fields

  /** The maximum number of entries that can be processed in a single run iteration. */
  public readonly continuousWorkMaxEntries: number;
  /** The amount of time that can be used for processing in a single run iteration. */
  public readonly continuousWorkTimeLimitMSec: number;
  /** The maximum number of entries that can be executed at once. */
  public readonly maxParallel: number;

  // Private Fields

  private processingCount = 0;

  private readonly heap = new Heap<InternalRunQueueEntry>((a, b) => a.priority - b.priority);

  // Constructor

  /**
   * @param id - A technical but human-readable ID for this queue
   * @param options - Options for customizing the behavior of the queue
   */
  constructor(public readonly id: string, options: RunQueueOptions = {}) {
    this.continuousWorkMaxEntries = options.continuousWorkMaxEntries ?? Number.MAX_SAFE_INTEGER;
    this.continuousWorkTimeLimitMSec = options.continuousWorkTimeLimitMSec ?? DEFAULT_CONTINUOUS_WORK_TIME_LIMIT_MSEC;
    this.maxParallel = options.maxParallel ?? DEFAULT_MAX_PARALLEL;
  }

  // Public Methods

  /** Cancels all outstanding cancelable entries */
  public readonly cancelAll = () => {
    let numEntriesCanceled = 0;
    for (const entry of this.heap.toArray()) {
      if (entry.cancel()) {
        numEntriesCanceled += 1;
      }
    }

    getStatsHandler().trackRunQueueDidCancelAllCancelableEntries?.({ runQueue: this, numEntriesCanceled });
  };

  /** Gets the total queue length, which may include canceled entries that haven't been purged yet */
  public readonly getQueueLength = () => this.heap.size();

  /**
   * Schedules a new entry to be run.
   *
   * @param priority - Lower number is higher priority
   * @param id - A technical but human-readable ID of the entry
   * @param run - The function to run
   * @param options - Options to effect the processing of this entry
   *
   * @returns An entry reference, which can be used to cancel the entry, check its status, or to get the promised value.
   */
  public readonly schedule = <T>(
    priority: number,
    id: string,
    run: () => Promise<T> | T,
    options: RunQueueScheduleOptions = {}
  ): RunQueueEntry<T> => {
    const entry: InternalRunQueueEntry<T> = {
      id,
      priority,
      wasCanceled: false,
      wasCompleted: false,
      wasStarted: false,
      neverCancel: options.neverCancel ?? false,
      run,
      // These placeholder functions are immediately replaced inside the promise
      cancel: placeholderCancel,
      resolve: placeholderResolve,
      reject: placeholderReject
    };

    const promise = new Promise<RunQueueEntryResult<T>>((resolve) => {
      entry.cancel = () => {
        if (entry.wasCanceled || entry.wasCompleted || entry.neverCancel) {
          return false;
        }

        entry.wasCanceled = true;
        resolve({ ok: false, details: CANCELED });

        getStatsHandler().trackRunQueueDidCancelEntry?.({ runQueue: this, entryId: id });

        return true;
      };

      entry.resolve = (value) => {
        if (entry.wasCompleted || entry.wasCanceled) {
          return;
        }

        entry.wasCompleted = true;
        resolve({ ok: true, details: value });
      };

      entry.reject = (e) => {
        if (entry.wasCompleted || entry.wasCanceled) {
          return;
        }

        entry.wasCompleted = true;
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        resolve({ ok: false, details: e });
      };

      this.heap.push(entry);
    });

    if (this.processingCount < this.maxParallel) {
      runAfterInteractions(this.id, this.processQueue);
    }

    getStatsHandler().trackRunQueueDidSchedule?.({ runQueue: this, entryId: id });

    return {
      promise,
      cancel: () => {
        entry.cancel();
      },
      wasCanceled: () => entry.wasCanceled,
      wasCompleted: () => entry.wasCompleted,
      wasStarted: () => entry.wasStarted
    };
  };

  // Private Methods

  private readonly getNextEntry = () => {
    if (this.processingCount >= this.maxParallel) {
      return undefined;
    }

    let cursor = this.heap.pop();
    while (cursor !== undefined && cursor.wasCanceled) {
      cursor = this.heap.pop();
    }
    return cursor;
  };

  private readonly processQueue = async () => {
    const startTimeMSec = performance.now();
    let numEntriesProcessed = 0;
    do {
      const next = this.getNextEntry();
      if (next === undefined) {
        return; // Nothing to do
      }

      const entryStartTimeMSec = performance.now();
      let success = false;
      try {
        this.processingCount += 1;

        next.wasStarted = true;
        next.resolve(await next.run());
        success = true;
      } catch (e) {
        next.reject(e);
      } finally {
        this.processingCount -= 1;
        numEntriesProcessed += 1;

        getStatsHandler().trackRunQueueDidProcessEntry?.({
          runQueue: this,
          entryId: next.id,
          durationMSec: performance.now() - entryStartTimeMSec,
          success
        });
      }
    } while (numEntriesProcessed < this.continuousWorkMaxEntries && performance.now() - startTimeMSec < this.continuousWorkTimeLimitMSec);

    getStatsHandler().trackRunQueueDidCompleteIteration?.({
      runQueue: this,
      numEntriesProcessed,
      durationMSec: performance.now() - startTimeMSec
    });

    runAfterInteractions(this.id, this.processQueue);
  };
}