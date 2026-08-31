/**
 * 状态 · 记忆 —— 图一第二层的 state.db。
 *
 * 用 Node 内置的 node:sqlite，零依赖。表结构一次性按图一的四张表建好
 * （messages / plays / plan / prefs），阶段①只用到前两张，
 * 后两张留给阶段③的调度器和偏好学习，届时不用改 schema。
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { Track } from "../music/types.ts";

export interface StoredMessage {
  role: "user" | "assistant";
  content: string;
  createdAt: number;
}

export interface PlayRecord {
  title: string;
  artist: string;
  providerId: string;
  provider: string;
  playedAt: number;
  /** 听完了还是几秒就切走了 */
  outcome: "played" | "skipped";
  /** 实际听了多久 */
  listenedMs: number;
}

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.addColumnIfMissing("messages", "payload", "TEXT");
    // plays 原本只在「被推荐」时写一行，于是这张表记的是推荐历史而不是收听历史。
    // 这两列把它们分开：outcome 说这首到底有没有被听，listened_ms 说听了多久。
    this.addColumnIfMissing("plays", "outcome", "TEXT NOT NULL DEFAULT 'queued'");
    this.addColumnIfMissing("plays", "listened_ms", "INTEGER NOT NULL DEFAULT 0");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        session    TEXT    NOT NULL,
        role       TEXT    NOT NULL,
        content    TEXT    NOT NULL,
        -- 整轮响应的 JSON（曲目、理由、过渡语…）。
        -- 只存 content 的话刷新后曲目卡片就没了，重新解析既慢又不准。
        payload    TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session
        ON messages(session, id);

      CREATE TABLE IF NOT EXISTS plays (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        session     TEXT    NOT NULL,
        provider    TEXT    NOT NULL,
        provider_id TEXT    NOT NULL,
        title       TEXT    NOT NULL,
        artist      TEXT    NOT NULL,
        played_at   INTEGER NOT NULL,
        -- queued  推荐进队列了，但还不知道有没有被听
        -- played  真的听完了（或听够了）
        -- skipped 播了几秒就切走
        outcome     TEXT    NOT NULL DEFAULT 'queued',
        listened_ms INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_plays_time ON plays(played_at DESC);

      -- 阶段③：调度器产出的当日播放计划
      CREATE TABLE IF NOT EXISTS plan (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        day        TEXT    NOT NULL,
        slot       TEXT    NOT NULL,
        payload    TEXT    NOT NULL,
        created_at INTEGER NOT NULL
      );

      -- 阶段③：从行为里学到的偏好，与 user/*.md 的手写偏好合并
      CREATE TABLE IF NOT EXISTS prefs (
        key        TEXT PRIMARY KEY,
        value      TEXT    NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  /** 老库补列。SQLite 没有 ADD COLUMN IF NOT EXISTS，只能先查再加。 */
  private addColumnIfMissing(table: string, column: string, decl: string): void {
    const exists = this.db
      .prepare(`SELECT 1 FROM pragma_table_info(?) WHERE name = ?`)
      .get(table, column);
    // 表还不存在时 pragma 返回空，建表语句本身会带上这一列
    const tableExists = this.db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?`)
      .get(table);
    if (tableExists && !exists) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
    }
  }

  appendMessage(
    session: string,
    role: "user" | "assistant",
    content: string,
    payload?: unknown,
  ): void {
    this.db
      .prepare(
        `INSERT INTO messages (session, role, content, payload, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        session,
        role,
        content,
        payload === undefined ? null : JSON.stringify(payload),
        Date.now(),
      );
  }

  /** 取最近 N 轮，按时间正序返回（模型需要正序） */
  recentMessages(session: string, limit = 20): StoredMessage[] {
    const rows = this.db
      .prepare(
        `SELECT role, content, created_at FROM messages
         WHERE session = ? ORDER BY id DESC LIMIT ?`,
      )
      .all(session, limit) as Array<{
      role: string;
      content: string;
      created_at: number;
    }>;
    return rows
      .reverse()
      .map((r) => ({
        role: r.role as "user" | "assistant",
        content: r.content,
        createdAt: r.created_at,
      }));
  }

  /** 供前端恢复整屏用：带上每轮的完整响应 */
  historyWithPayload(session: string, limit = 40): Array<{
    role: "user" | "assistant";
    content: string;
    payload: unknown | null;
    createdAt: number;
  }> {
    const rows = this.db
      .prepare(
        `SELECT role, content, payload, created_at FROM messages
         WHERE session = ? ORDER BY id DESC LIMIT ?`,
      )
      .all(session, limit) as Array<{
      role: string; content: string; payload: string | null; created_at: number;
    }>;
    return rows.reverse().map((r) => ({
      role: r.role as "user" | "assistant",
      content: r.content,
      payload: r.payload ? JSON.parse(r.payload) : null,
      createdAt: r.created_at,
    }));
  }

  /** 清空一个会话 —— 调语料时要频繁用，历史会污染新语料的效果判断 */
  clearSession(session: string): void {
    this.db.prepare("DELETE FROM messages WHERE session = ?").run(session);
    this.db.prepare("DELETE FROM plays WHERE session = ?").run(session);
  }

  /**
   * 资料页的三个数字。
   *
   * 只数 outcome='played' —— 「推荐了 40 首」和「听了 3 首」是完全不同的两件事，
   * 把前者显示成 Played 是在骗自己。高峰时段同理：
   * 按推荐时刻聚合出来的「高峰」只反映你什么时候在跟它说话。
   */
  stats(): { played: number; peakHour: number | null } {
    const played = (
      this.db
        .prepare("SELECT COUNT(*) AS n FROM plays WHERE outcome = 'played'")
        .get() as { n: number }
    ).n;

    const row = this.db
      .prepare(
        `SELECT CAST(strftime('%H', played_at / 1000, 'unixepoch', 'localtime') AS INTEGER) AS h,
                COUNT(*) AS n
         FROM plays WHERE outcome = 'played' GROUP BY h ORDER BY n DESC, h ASC LIMIT 1`,
      )
      .get() as { h: number; n: number } | undefined;

    return { played, peakHour: row ? row.h : null };
  }

  /**
   * 一首歌进了队列。这不等于它被听了 ——
   * 落这一行是为了记住「推荐过什么」，outcome 要等前端上报才会变。
   */
  recordQueued(session: string, track: Track): void {
    this.db
      .prepare(
        `INSERT INTO plays (session, provider, provider_id, title, artist, played_at, outcome)
         VALUES (?, ?, ?, ?, ?, ?, 'queued')`,
      )
      .run(session, track.provider, track.providerId, track.title, track.artist, Date.now());
  }

  /**
   * 前端上报「这首实际听了多久」。
   *
   * 判定听完的门槛取两者之一：听满六成，或者听够 30 秒。
   * 后一条是为 30 秒试听准备的 —— 试听放到底就是听完了，
   * 但按整曲时长算永远只有 10%，会被误判成跳过。
   *
   * 这里**插入新行**，而不是去改那条 queued 的记录。
   * 原先是改：`UPDATE ... WHERE provider_id = ?`。那个写法只在
   * 「这首歌刚被对话推荐过」时成立 —— 调度器排好的节目单、
   * 从历史里重新载入的旧队列，plays 表里都没有对应的 queued 行，
   * UPDATE 一行都没命中，接口却照样返回 ok，收听被静默丢掉。
   *
   * 分成两种行之后语义也更干净：queued 是纯粹的推荐流水，
   * played/skipped 是纯粹的收听流水，各自的时间戳都是真的。
   */
  recordListen(
    session: string,
    track: Pick<Track, "provider" | "providerId" | "title" | "artist">,
    listenedMs: number,
    durationMs?: number,
  ): "played" | "skipped" {
    const enough =
      listenedMs >= 30_000 ||
      (durationMs ? listenedMs >= durationMs * 0.6 : false);
    const outcome = enough ? "played" : "skipped";

    this.db
      .prepare(
        `INSERT INTO plays
           (session, provider, provider_id, title, artist, played_at, outcome, listened_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session,
        track.provider,
        track.providerId,
        track.title,
        track.artist,
        Date.now(),
        outcome,
        Math.round(listenedMs),
      );
    return outcome;
  }

  /**
   * 真正发生过的收听。
   *
   * 刻意排除 outcome='queued' —— 那些只是被推荐进过队列，
   * 谁也不知道有没有被听。把它们当播放记录喂回模型，
   * 等于让它以为你听过一堆其实没听过的歌，然后据此推下一批。
   */
  recentPlays(limit = 15): PlayRecord[] {
    const rows = this.db
      .prepare(
        `SELECT title, artist, provider, provider_id, played_at, outcome, listened_ms
         FROM plays WHERE outcome != 'queued'
         ORDER BY played_at DESC LIMIT ?`,
      )
      .all(limit) as Array<{
      title: string;
      artist: string;
      provider: string;
      provider_id: string;
      played_at: number;
      outcome: string;
      listened_ms: number;
    }>;
    return rows.map((r) => ({
      title: r.title,
      artist: r.artist,
      provider: r.provider,
      providerId: r.provider_id,
      playedAt: r.played_at,
      outcome: r.outcome === "skipped" ? "skipped" : "played",
      listenedMs: r.listened_ms,
    }));
  }

  /**
   * 刚推荐过、但还不知道有没有被听的曲目。
   *
   * 第④片刻意排除了 queued —— 把「推过」说成「听过」是撒谎。
   * 但完全不告诉模型它刚推过什么，它就会连着两轮推同一批歌
   * （实测第二轮重复了第一轮的两首）。所以单独给一片，
   * 措辞上与「听过」严格分开：这是「别重复」，不是「他喜欢」。
   */
  recentQueuedAsContext(session: string, limit = 10): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT title, artist FROM plays
         WHERE session = ? AND outcome = 'queued'
         ORDER BY played_at DESC LIMIT ?`,
      )
      .all(session, limit) as Array<{ title: string; artist: string }>;
    return rows.map((r) => `${r.artist} - ${r.title}`);
  }

  /**
   * 渲染成喂给 ④「已检索记忆」那一片的文本。
   *
   * 跳过的必须显式说出来，而且比听完的更有信息量 ——
   * 「推了但你几秒就切了」是一条明确的负反馈，
   * 混在播放记录里说成「播过」会让模型继续往那个方向推。
   */
  recentPlaysAsContext(limit = 15): string[] {
    const now = Date.now();
    return this.recentPlays(limit).map((p) => {
      const mins = Math.round((now - p.playedAt) / 60000);
      const when =
        mins < 60 ? `${mins} 分钟前`
        : mins < 1440 ? `${Math.round(mins / 60)} 小时前`
        : `${Math.round(mins / 1440)} 天前`;
      if (p.outcome === "skipped") {
        const secs = Math.round(p.listenedMs / 1000);
        return `${p.artist} - ${p.title}（${when}，只听了 ${secs} 秒就切走了）`;
      }
      return `${p.artist} - ${p.title}（${when}，听完了）`;
    });
  }

  // ── 阶段③：调度器的当日计划 ─────────────────────────────
  //
  // 一天一档一行。重排同一档就覆盖 —— 计划是「现在打算怎么播」，
  // 不是历史流水；历史在 plays 表里，那才是真正发生过的事。

  savePlan(day: string, slot: string, payload: unknown): void {
    this.db
      .prepare(`DELETE FROM plan WHERE day = ? AND slot = ?`)
      .run(day, slot);
    this.db
      .prepare(
        `INSERT INTO plan (day, slot, payload, created_at) VALUES (?, ?, ?, ?)`,
      )
      .run(day, slot, JSON.stringify(payload), Date.now());
  }

  planForDay(day: string): Array<{ slot: string; payload: any; createdAt: number }> {
    const rows = this.db
      .prepare(`SELECT slot, payload, created_at FROM plan WHERE day = ? ORDER BY id`)
      .all(day) as Array<{ slot: string; payload: string; created_at: number }>;
    return rows.map((r) => ({
      slot: r.slot,
      // 手改过库、或早期版本写进去的脏数据不该让整个接口 500
      payload: safeParse(r.payload),
      createdAt: r.created_at,
    }));
  }

  clearPlan(day: string): void {
    this.db.prepare(`DELETE FROM plan WHERE day = ?`).run(day);
  }

  /** 只保留最近几天的计划 —— 过期的计划没有任何回看价值 */
  prunePlans(keepDays = 3): void {
    const cutoff = new Date(Date.now() - keepDays * 86_400_000)
      .toISOString()
      .slice(0, 10);
    this.db.prepare(`DELETE FROM plan WHERE day < ?`).run(cutoff);
  }

  // ── 阶段③：从行为里学到的偏好 ─────────────────────────
  //
  // 与 user/*.md 的分工是清楚的：
  //   语料  = 只有你知道的事（为什么喜欢、什么时候不听）
  //   prefs = 只有数字知道的事（哪些艺人你会复听、哪些收了没听）
  // 两边都不该去写对方那一半。

  setPref(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO prefs (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, Date.now());
  }

  getPref(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM prefs WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  allPrefs(): Array<{ key: string; value: string; updatedAt: number }> {
    const rows = this.db
      .prepare(`SELECT key, value, updated_at FROM prefs ORDER BY key`)
      .all() as Array<{ key: string; value: string; updated_at: number }>;
    return rows.map((r) => ({ key: r.key, value: r.value, updatedAt: r.updated_at }));
  }

  /**
   * 收听行为的聚合，给 npm run prefs 用。
   *
   * 只看有结论的行（听完 / 跳过），queued 的不算 —— 它们什么也没说明。
   */
  outcomeStats(): {
    played: number;
    skipped: number;
    skippedArtists: Array<{ artist: string; n: number }>;
    playedArtists: Array<{ artist: string; n: number }>;
  } {
    const count = (outcome: string) =>
      (this.db
        .prepare("SELECT COUNT(*) AS n FROM plays WHERE outcome = ?")
        .get(outcome) as { n: number }).n;

    const byArtist = (outcome: string) =>
      this.db
        .prepare(
          `SELECT artist, COUNT(*) AS n FROM plays WHERE outcome = ?
           GROUP BY artist ORDER BY n DESC, artist ASC LIMIT 8`,
        )
        .all(outcome) as Array<{ artist: string; n: number }>;

    return {
      played: count("played"),
      skipped: count("skipped"),
      skippedArtists: byArtist("skipped"),
      playedArtists: byArtist("played"),
    };
  }

  deletePref(key: string): void {
    this.db.prepare(`DELETE FROM prefs WHERE key = ?`).run(key);
  }

  /**
   * 渲染成喂给模型的那一片。
   *
   * key 用 `分类.名字` 的形式，这里按分类前缀分组 ——
   * 一行一条平铺出来模型读不出结构，分了组它才知道
   * 「deep 和 shallow 是同一个维度的两端」。
   */
  prefsAsContext(): string[] {
    return this.allPrefs().map((p) => `${p.key}：${p.value}`);
  }

  close(): void {
    this.db.close();
  }
}

function safeParse(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
