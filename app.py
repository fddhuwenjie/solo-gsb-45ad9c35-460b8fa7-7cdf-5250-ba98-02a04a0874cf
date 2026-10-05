"""直播节目串联单 —— Flask + SQLite + 原生 JavaScript。

功能概要：
- 设置节目起点与总秒数；
- 录入固定时长的赞助段、带目标/最短/最长秒数的访谈段；
- 整份未播清单一次编辑（插入/删除/移动访谈段），播出开始后赞助段的时长与先后顺序锁定；
- 以实际已播总时长计算剩余时间：先沿用访谈目标时长，再按清单顺序在各自
  [最短, 最长] 范围内分摊差额，恰好排到节目终点；无法排满或超时则给出差额并拒绝编辑；
- 每结束当前段录入实际秒数，记录永久保留，即使余下清单无解也只显示冲突、允许再次编辑；
- 已播记录不可改写；SQLite 持久化，重启后实况与待播排期仍在。
"""

import os
import sqlite3
from datetime import datetime, timedelta

from flask import Flask, g, jsonify, render_template, request

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("DB_PATH", os.path.join(BASE_DIR, "rundown.db"))

app = Flask(__name__)

SCHEMA = """
CREATE TABLE IF NOT EXISTS show_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    start_at TEXT NOT NULL,                 -- 节目起点，ISO 本地时间
    total_seconds INTEGER NOT NULL CHECK (total_seconds > 0)
);

CREATE TABLE IF NOT EXISTS segments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('sponsor', 'interview')),
    title TEXT NOT NULL,
    position INTEGER NOT NULL,              -- 串联单顺序（已播段永远排在待播段之前）
    fixed_seconds INTEGER,                  -- 赞助段：固定时长
    target_seconds INTEGER,                 -- 访谈段：目标时长
    min_seconds INTEGER,                    -- 访谈段：最短时长
    max_seconds INTEGER,                    -- 访谈段：最长时长
    aired INTEGER NOT NULL DEFAULT 0,
    actual_seconds INTEGER,                 -- 已播：实际秒数（记录不可改写）
    aired_at TEXT                           -- 已播：记录时刻
);
"""


# ---------------------------------------------------------------- 数据库

def get_db():
    if "db" not in g:
        conn = sqlite3.connect(DB_PATH, timeout=10)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode = WAL")
        g.db = conn
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    """启动时自动建库建表。"""
    directory = os.path.dirname(DB_PATH)
    if directory:
        os.makedirs(directory, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    try:
        conn.executescript(SCHEMA)
        conn.commit()
    finally:
        conn.close()


init_db()  # 模块导入即执行，保证 gunicorn / flask run / python app.py 都会自动建库


# ---------------------------------------------------------------- 工具

def is_pos_int(v):
    return isinstance(v, int) and not isinstance(v, bool) and v > 0


def row_to_segment(r):
    seg = {
        "id": r["id"],
        "kind": r["kind"],
        "title": r["title"],
        "aired": bool(r["aired"]),
    }
    if r["kind"] == "sponsor":
        seg["fixed_seconds"] = r["fixed_seconds"]
    else:
        seg["target_seconds"] = r["target_seconds"]
        seg["min_seconds"] = r["min_seconds"]
        seg["max_seconds"] = r["max_seconds"]
    if r["aired"]:
        seg["actual_seconds"] = r["actual_seconds"]
        seg["aired_at"] = r["aired_at"]
    return seg


def compute_plan(pending, remaining):
    """为待播清单计算每段计划秒数。

    规则：赞助段固定；访谈段先沿用目标时长，再按清单顺序在各自
    [min, max] 范围内分摊差额（剩余多了就依次拉长，少了就依次压短），
    目标是恰好排到节目终点。

    返回 (plan, conflict)：
      plan     —— {分段 id: 计划秒数}（尽力分摊后的结果，供页面展示预计起止）
      conflict —— None 表示恰好排满；否则 {"kind": "short"|"over", "seconds": 差额}
                  short = 无法排满（全部拉到最长仍差的秒数）
                  over  = 超时（全部压到最短仍超出的秒数）
    """
    plan = {}
    fixed_total = 0
    interviews = []
    for s in pending:
        if s["kind"] == "sponsor":
            plan[s["id"]] = s["fixed_seconds"]
            fixed_total += s["fixed_seconds"]
        else:
            plan[s["id"]] = s["target_seconds"]
            interviews.append(s)

    diff = remaining - fixed_total - sum(s["target_seconds"] for s in interviews)
    if diff > 0:  # 剩余时间偏多：按清单顺序把访谈依次拉长（至多拉到最长）
        rest = diff
        for s in interviews:
            add = min(s["max_seconds"] - s["target_seconds"], rest)
            plan[s["id"]] += add
            rest -= add
            if rest == 0:
                break
        if rest > 0:
            return plan, {"kind": "short", "seconds": rest}
    elif diff < 0:  # 剩余时间偏少：按顺序把访谈压短到此项最短
        rest = -diff
        for s in interviews:
            cut = min(s["target_seconds"] - s["min_seconds"], rest)
            plan[s["id"]] -= cut
            rest -= cut
            if rest == 0:
                break
        if rest > 0:
            return plan, {"kind": "over", "seconds": rest}
    return plan, None


def build_state():
    db = get_db()
    show = db.execute("SELECT * FROM show_config WHERE id = 1").fetchone()
    if show is None:
        return {
            "show": None, "aired": [], "pending": [],
            "elapsed_actual": 0, "remaining": None,
            "feasible": True, "conflict": None, "current_id": None,
        }

    rows = db.execute("SELECT * FROM segments ORDER BY position").fetchall()
    aired = [row_to_segment(r) for r in rows if r["aired"]]
    pending = [row_to_segment(r) for r in rows if not r["aired"]]

    elapsed = sum(a["actual_seconds"] for a in aired)
    total = show["total_seconds"]
    remaining = total - elapsed

    plan, conflict = compute_plan(pending, remaining)

    start = datetime.fromisoformat(show["start_at"])
    # 待播排期从「起点 + 实际已播总时长」起依次衔接
    cursor = start + timedelta(seconds=elapsed)
    for s in pending:
        s["planned_seconds"] = plan[s["id"]]
        s["est_start"] = cursor.isoformat()
        cursor += timedelta(seconds=s["planned_seconds"])
        s["est_end"] = cursor.isoformat()

    return {
        "show": {
            "start_at": show["start_at"],
            "total_seconds": total,
            "end_at": (start + timedelta(seconds=total)).isoformat(),
        },
        "aired": aired,
        "pending": pending,
        "elapsed_actual": elapsed,
        "remaining": remaining,
        "feasible": conflict is None,
        "conflict": conflict,
        "current_id": pending[0]["id"] if pending else None,
    }


def conflict_message(conflict):
    if conflict["kind"] == "short":
        return f"无法排满：即使所有访谈段都拉到最长，仍差 {conflict['seconds']} 秒"
    return f"超时：即使所有访谈段都压到最短，仍超出 {conflict['seconds']} 秒"


# ---------------------------------------------------------------- 页面

@app.route("/")
def index():
    return render_template("index.html")


# ---------------------------------------------------------------- API

@app.get("/api/state")
def api_state():
    return jsonify(build_state())


@app.post("/api/show")
def api_show():
    """设置（或播出前修改）节目起点与总秒数。"""
    data = request.get_json(force=True, silent=True) or {}
    start_at = str(data.get("start_at", "")).strip()
    total = data.get("total_seconds")

    try:
        start = datetime.fromisoformat(start_at)
    except ValueError:
        return jsonify(error="节目起点时间格式不正确"), 400
    if not is_pos_int(total):
        return jsonify(error="总秒数必须为正整数"), 400

    db = get_db()
    aired_count = db.execute(
        "SELECT COUNT(*) AS c FROM segments WHERE aired = 1").fetchone()["c"]
    if aired_count:
        return jsonify(error="已有播出记录，不能再修改节目起点或总秒数"), 409

    db.execute(
        "INSERT INTO show_config (id, start_at, total_seconds) VALUES (1, ?, ?) "
        "ON CONFLICT(id) DO UPDATE SET start_at = excluded.start_at, "
        "total_seconds = excluded.total_seconds",
        (start.isoformat(timespec="seconds"), total),
    )
    db.commit()
    return jsonify(build_state())


@app.put("/api/rundown")
def api_rundown():
    """整份替换未播清单。

    请求体：{"segments": [...]}，每项：
      - id（可选）：引用现有待播段；缺省表示新增段
      - kind: "sponsor" | "interview"
      - title
      - 赞助段: fixed_seconds；访谈段: target/min/max_seconds
    未出现在列表中的现有待播段将被删除。
    """
    data = request.get_json(force=True, silent=True) or {}
    items = data.get("segments")
    if not isinstance(items, list):
        return jsonify(error="segments 必须是数组"), 400

    db = get_db()
    show = db.execute("SELECT * FROM show_config WHERE id = 1").fetchone()
    if show is None:
        return jsonify(error="请先设置节目起点与总秒数"), 409

    rows = db.execute("SELECT * FROM segments ORDER BY position").fetchall()
    aired_rows = [r for r in rows if r["aired"]]
    pending_rows = [r for r in rows if not r["aired"]]
    pending_by_id = {r["id"]: r for r in pending_rows}

    # ---- 逐项校验并清洗 ----
    cleaned = []
    seen_ids = set()
    for i, it in enumerate(items):
        if not isinstance(it, dict):
            return jsonify(error=f"第 {i + 1} 段格式不正确"), 400
        kind = it.get("kind")
        if kind not in ("sponsor", "interview"):
            return jsonify(error=f"第 {i + 1} 段的类型必须是 sponsor 或 interview"), 400
        title = str(it.get("title") or "").strip() or (
            "赞助段" if kind == "sponsor" else "访谈段")
        seg = {"id": None, "kind": kind, "title": title}

        sid = it.get("id")
        if sid is not None:
            if not isinstance(sid, int) or isinstance(sid, bool) or sid not in pending_by_id:
                return jsonify(error=f"第 {i + 1} 段引用了不存在或已播出的分段"), 400
            if sid in seen_ids:
                return jsonify(error=f"分段 #{sid} 在清单中重复出现"), 400
            seen_ids.add(sid)
            if pending_by_id[sid]["kind"] != kind:
                return jsonify(error=f"第 {i + 1} 段不能改变已有分段的类型"), 400
            seg["id"] = sid

        if kind == "sponsor":
            fixed = it.get("fixed_seconds")
            if not is_pos_int(fixed):
                return jsonify(error=f"第 {i + 1} 段（赞助）的固定时长必须为正整数秒"), 400
            seg["fixed_seconds"] = fixed
        else:
            target = it.get("target_seconds")
            min_s = it.get("min_seconds")
            max_s = it.get("max_seconds")
            if not all(is_pos_int(v) for v in (target, min_s, max_s)):
                return jsonify(error=f"第 {i + 1} 段（访谈）的目标/最短/最长秒数必须为正整数"), 400
            if not (min_s <= target <= max_s):
                return jsonify(error=f"第 {i + 1} 段（访谈）需满足 最短 ≤ 目标 ≤ 最长"), 400
            seg.update(target_seconds=target, min_seconds=min_s, max_seconds=max_s)
        cleaned.append(seg)

    # ---- 播出开始后：赞助段的时长与先后顺序锁定 ----
    if aired_rows:
        current_sponsors = [
            (r["id"], r["fixed_seconds"]) for r in pending_rows if r["kind"] == "sponsor"]
        submitted_sponsors = [
            (s["id"], s["fixed_seconds"]) for s in cleaned if s["kind"] == "sponsor"]
        if any(sid is None for sid, _ in submitted_sponsors):
            return jsonify(error="播出开始后不能再新增赞助段"), 409
        if current_sponsors != submitted_sponsors:
            return jsonify(error="赞助段的时长和先后顺序不能改变"), 409

    # ---- 排期校验：必须恰好排到节目终点，否则给出差额并拒绝 ----
    elapsed = sum(r["actual_seconds"] for r in aired_rows)
    remaining = show["total_seconds"] - elapsed
    pseudo = []
    for idx, s in enumerate(cleaned):
        d = dict(s)
        d["id"] = s["id"] if s["id"] is not None else -(idx + 1)  # 临时 id 仅供试算
        pseudo.append(d)
    _, conflict = compute_plan(pseudo, remaining)
    if conflict is not None:
        return jsonify(error=conflict_message(conflict),
                       kind=conflict["kind"], seconds=conflict["seconds"]), 422

    # ---- 落库（事务） ----
    keep_ids = {s["id"] for s in cleaned if s["id"] is not None}
    base = db.execute(
        "SELECT COALESCE(MAX(position), -1) AS p FROM segments WHERE aired = 1"
    ).fetchone()["p"] + 1
    try:
        with db:
            for r in pending_rows:
                if r["id"] not in keep_ids:
                    db.execute("DELETE FROM segments WHERE id = ?", (r["id"],))
            for i, s in enumerate(cleaned):
                pos = base + i
                if s["id"] is not None:
                    if s["kind"] == "sponsor":
                        db.execute(
                            "UPDATE segments SET title = ?, position = ?, "
                            "fixed_seconds = ? WHERE id = ? AND aired = 0",
                            (s["title"], pos, s["fixed_seconds"], s["id"]))
                    else:
                        db.execute(
                            "UPDATE segments SET title = ?, position = ?, "
                            "target_seconds = ?, min_seconds = ?, max_seconds = ? "
                            "WHERE id = ? AND aired = 0",
                            (s["title"], pos, s["target_seconds"],
                             s["min_seconds"], s["max_seconds"], s["id"]))
                else:
                    if s["kind"] == "sponsor":
                        db.execute(
                            "INSERT INTO segments (kind, title, position, fixed_seconds) "
                            "VALUES ('sponsor', ?, ?, ?)",
                            (s["title"], pos, s["fixed_seconds"]))
                    else:
                        db.execute(
                            "INSERT INTO segments (kind, title, position, "
                            "target_seconds, min_seconds, max_seconds) "
                            "VALUES ('interview', ?, ?, ?, ?, ?)",
                            (s["title"], pos, s["target_seconds"],
                             s["min_seconds"], s["max_seconds"]))
    except sqlite3.Error as exc:
        return jsonify(error=f"保存失败：{exc}"), 500

    return jsonify(build_state())


@app.post("/api/finish")
def api_finish():
    """结束当前段（待播清单第一段），录入实际秒数。

    记录一旦写入即不可改写；即使余下清单因此无解，也保留记录并显示冲突。
    """
    data = request.get_json(force=True, silent=True) or {}
    actual = data.get("actual_seconds")
    if not is_pos_int(actual):
        return jsonify(error="实际秒数必须为正整数"), 400

    db = get_db()
    current = db.execute(
        "SELECT id FROM segments WHERE aired = 0 ORDER BY position LIMIT 1"
    ).fetchone()
    if current is None:
        return jsonify(error="没有待播出的分段"), 409

    with db:
        db.execute(
            "UPDATE segments SET aired = 1, actual_seconds = ?, aired_at = ? "
            "WHERE id = ? AND aired = 0",
            (actual, datetime.now().isoformat(timespec="seconds"), current["id"]))
    return jsonify(build_state())


@app.post("/api/reset")
def api_reset():
    """清空节目设置与全部分段（含已播记录），用于重新开始一档节目。"""
    db = get_db()
    with db:
        db.execute("DELETE FROM segments")
        db.execute("DELETE FROM show_config")
    return jsonify(build_state())


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8000)
