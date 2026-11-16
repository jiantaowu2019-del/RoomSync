from fastapi import HTTPException


def list_groups(cur, actor_id):
    cur.execute("""
        SELECT g.id, g.name, g.creator_id, m.status
        FROM groups g JOIN group_memberships m ON m.group_id = g.id
        WHERE m.member_id = %s ORDER BY g.id
    """, (actor_id,))
    return cur.fetchall()


def create_group(cur, actor_id, name):
    cur.execute("INSERT INTO groups (name, creator_id) VALUES (%s, %s) RETURNING id", (name, actor_id))
    group_id = cur.fetchone()["id"]
    cur.execute("""
        INSERT INTO group_memberships (group_id, member_id, status) VALUES (%s, %s, 'active')
    """, (group_id, actor_id))
    return {"id": group_id}


def require_group(cur, group_id, actor_id):
    cur.execute("""
        SELECT g.id, g.name, g.creator_id
        FROM groups g JOIN group_memberships m ON m.group_id = g.id
        WHERE g.id = %s AND m.member_id = %s AND m.status = 'active'
    """, (group_id, actor_id))
    group = cur.fetchone()
    if group is None:
        raise HTTPException(404, "Group not found.")
    return group


def group_detail(cur, group_id, actor_id):
    group = require_group(cur, group_id, actor_id)
    cur.execute("""
        SELECT u.id, u.display_name
        FROM group_memberships m JOIN members u ON u.id = m.member_id
        WHERE m.group_id = %s AND m.status = 'active' ORDER BY u.id
    """, (group_id,))
    return {**group, "members": cur.fetchall()}


def invite(cur, group_id, actor_id, username):
    group = require_group(cur, group_id, actor_id)
    if group["creator_id"] != actor_id:
        raise HTTPException(403, "Only the group creator can invite members.")
    cur.execute("SELECT id FROM members WHERE username = %s AND demo_member", (username,))
    member = cur.fetchone()
    if member is None:
        raise HTTPException(404, "Account not found.")
    cur.execute("""
        INSERT INTO group_memberships (group_id, member_id, status) VALUES (%s, %s, 'invited')
        ON CONFLICT (group_id, member_id) DO NOTHING
    """, (group_id, member["id"]))


def join(cur, group_id, actor_id):
    cur.execute("""
        UPDATE group_memberships SET status = 'active'
        WHERE group_id = %s AND member_id = %s RETURNING member_id
    """, (group_id, actor_id))
    if cur.fetchone() is None:
        raise HTTPException(404, "Invitation not found.")
