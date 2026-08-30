/**
 * 时段触发器 —— 让电台自己开播。
 *
 * 调度器（planner.ts）只负责**排**：它把每个时段该放什么写进 plan 表。
 * 在此之前没有任何东西负责**播** —— 节目表躺在库里，你打开页面才看得见，
 * 它不会在时段到点的时候做任何事。这个文件补上那一环。
 *
 * 做法刻意保持笨拙：每分钟算一次「现在属于哪一档」，和上一分钟比，
 * 变了就是一次换档。不用 cron、不预先排定时器 ——
 *   · routines.md 随时会被改，预排的定时器立刻就是过期的
 *   · 笔记本会睡眠。睡醒之后 setTimeout 的行为没有保证，
 *     而「每分钟看一眼现在几点」睡醒就自动对上了
 *
 * 它**不会**自己去排期。排期要调模型、要花钱，
 * 那必须是人按下按钮的结果，不能是时钟走到某一格的结果。
 */

import { currentSlot } from "../context/routines.ts";
import { today } from "./planner.ts";
import type { Store } from "../state/store.ts";

/** 一分钟看一眼。比时段边界精细得多，又不至于空转。 */
const TICK_MS = 60_000;

export interface OnAir {
  /** 当前档名，比如「起床」 */
  slot: string;
  /** 场景名的来源：用户语料还是内置兜底 */
  source: "routines.md" | "fallback";
  /** 这一档是什么时候开始的（换档那一刻的时间戳） */
  since: number;
  /** 这一档有没有排好的节目单 */
  hasPlan: boolean;
}

export interface TickerOptions {
  rootDir: string;
  store: Store;
  /** 换档时回调，用于打日志 */
  onChange?: (next: OnAir, prev: OnAir | null) => void;
  /**
   * 换到一个还没排期的档时，自动为它排一次。
   *
   * 这个钩子**会花钱**（一次模型调用），所以默认不接 ——
   * 由 server.ts 根据 CLAUDIO_AUTOPLAN 决定要不要传进来。
   * 触发器本身不知道排期要花钱，它只知道「这一档空着」。
   */
  autoPlan?: (slot: string) => Promise<void>;
}

export class Ticker {
  private current: OnAir | null = null;
  private timer: NodeJS.Timeout | null = null;
  // 不写成构造函数参数属性：Node 原生跑 TS 只做语法剥离，
  // 参数属性会生成代码，erasableSyntaxOnly 因此禁掉了它
  private opts: TickerOptions;

  constructor(opts: TickerOptions) {
    this.opts = opts;
  }

  /** 现在正在播出的这一档。前端每分钟拉一次 /api/now 就能拿到。 */
  get onAir(): OnAir | null {
    return this.current;
  }

  async start(): Promise<void> {
    await this.tick(); // 先立刻对一次，别让启动后第一分钟是空的
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    // 这个定时器不该拖住进程退出
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    let slot;
    try {
      slot = await currentSlot(this.opts.rootDir);
    } catch {
      return; // routines.md 读不出来就跳过这一分钟，不影响下一次
    }

    // 档名没变 = 还在同一档里，只刷新一下节目单是否已就绪
    if (this.current && this.current.slot === slot.name) {
      this.current.hasPlan = this.planExists(slot.name);
      return;
    }

    const prev = this.current;
    this.current = {
      slot: slot.name,
      source: slot.source,
      // 这里用「现在」而不是时段的名义起点：
      // 服务是刚起的、还是笔记本刚睡醒，都该如实反映成刚刚换档
      since: Date.now(),
      hasPlan: this.planExists(slot.name),
    };
    this.opts.onChange?.(this.current, prev);

    // 这一档空着就补排一次。只对 routines.md 里写明的时段做 ——
    // 兜底时段名（「夜晚」这种）在 routines.md 里找不到对应的时间段，
    // 排期会返回空，白白付一次调用。
    if (
      this.opts.autoPlan &&
      !this.current.hasPlan &&
      slot.source === "routines.md"
    ) {
      const target = slot.name;
      void this.opts
        .autoPlan(target)
        .then(() => {
          // 排完了要把 hasPlan 更新掉，否则要等下一分钟前端才看得见
          if (this.current?.slot === target) {
            this.current.hasPlan = this.planExists(target);
          }
        })
        .catch(() => {
          // 排期失败不该影响换档本身 —— 这一档照样是当前档，只是没节目单
        });
    }
  }

  private planExists(slot: string): boolean {
    try {
      return this.opts.store.planForDay(today()).some((p) => p.slot === slot);
    } catch {
      return false;
    }
  }
}
