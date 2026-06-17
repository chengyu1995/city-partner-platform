"""
创表测试脚本: 调 Vercel 路由 /api/feishu/create-tables
结果写 C:\Users\admin\AppData\Local\Temp\create_result.json
"""
import urllib.request
import json

TOK = "FsApi@2026XyZ9876abcdefghijKLmnopQRstuvWxYz123456!@#$%^&*"
URL = "https://city-partner-platform.vercel.app/api/feishu/create-tables"
OUT = r"C:\Users\admin\AppData\Local\Temp\create_result.json"

req = urllib.request.Request(
    URL,
    data=b"",
    headers={"Authorization": "Bearer " + TOK},
    method="POST",
)
try:
    resp = json.loads(urllib.request.urlopen(req, timeout=120).read())
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(resp, f, ensure_ascii=False, indent=2)
    print("OK 200 -> 写文件 " + OUT)
except urllib.error.HTTPError as e:
    body = e.read().decode("utf-8", errors="replace")
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(body)
    print("HTTP " + str(e.code) + " -> 写文件 " + OUT)
