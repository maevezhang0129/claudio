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
        played_at   INTEGER NOT NULL
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

  /** 资料页的三个数字 */
  stats(): { played: number; peakHour: number | null } {
    const played = (
      this.db.prepare("SELECT COUNT(*) AS n FROM plays").get() as { n: number }
    ).n;

    // 按本地小时聚合播放时刻，取最高的那一格
    const row = this.db
      .prepare(
        `SELECT CAST(strftime('%H', played_at / 1000, 'unixepoch', 'localtime') AS INTEGER) AS h,
                COUNT(*) AS n
         FROM plays GROUP BY h ORDER BY n DESC, h ASC LIMIT 1`,
      )
      .get() as { h: number; n: number } | undefined;

    return { played, peakHour: row ? row.h : null };
  }

  recordPlay(session: string, track: Track): void {
    this.db
      .prepare(
        `INSERT INTO plays (session, provider, provider_id, title, artist, played_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(session, track.provider, track.providerId, track.title, track.artist, Date.now());
  }

  recentPlays(limit = 15): PlayRecord[] {
    const rows = this.db
      .prepare(
        `SELECT title, artist, provider, provider_id, played_at
         FROM plays ORDER BY played_at DESC LIMIT ?`,
      )
      .all(limit) as Array<{
      title: string;
      artist: string;
      provider: string;
      provider_id: string;
      played_at: number;
    }>;
    return rows.map((r) => ({
      title: r.title,
      artist: r.artist,
      provider: r.provider,
      providerId: r.provider_id,
      playedAt: r.played_at,
    }));
  }

  /** 渲染成喂给 ④「已检索记忆」那一片的文本 */
  recentPlaysAsContext(limit = 15): string[] {
    const now = Date.now();
    return this.recentPlays(limit).map((p) => {
      const mins = Math.round((now - p.playedAt) / 60000);
      const when =
        mins < 60 ? `${mins} 分钟前`
        : mins < 1440 ? `${Math.round(mins / 60)} 小时前`
        : `${Math.round(mins / 1440)} 天前`;
      return `${p.artist} - ${p.title}（${when}）`;
    });
  }

  close(): void {
    this.db.close();
  }
}
