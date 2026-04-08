#!/usr/bin/env python3
"""
用法：python3 gen_password.py
输入密码，输出可以直接放进 users.json 的 password_hash
"""
import hashlib, json, sys

def hash_pw(pw: str) -> str:
    return hashlib.sha256(pw.encode()).hexdigest()

if __name__ == "__main__":
    if len(sys.argv) > 1:
        # 直接传参: python3 gen_password.py mypassword
        pw = sys.argv[1]
        print(hash_pw(pw))
    else:
        print("=== Nick Speaking Platform — 密码生成工具 ===\n")
        while True:
            username    = input("账号 (留空退出): ").strip()
            if not username: break
            display     = input(f"显示名称 (默认: {username}): ").strip() or username
            password    = input("密码: ").strip()
            if not password:
                print("密码不能为空\n"); continue
            entry = {
                "username": username,
                "password_hash": hash_pw(password),
                "display_name": display
            }
            print(f"\n复制这段 JSON 加入 users.json：")
            print(json.dumps(entry, ensure_ascii=False, indent=2))
            print()

        # 内置示例
        print("\n── 内置账号密码说明 ──")
        examples = [
            ("nick", "123456", "Nick 老师"),
            ("student1", "password123", "同学甲"),
        ]
        for u, p, d in examples:
            print(f"  {u} / {p}  →  hash: {hash_pw(p)[:16]}…")
