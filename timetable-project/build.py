# build.py — รวมไฟล์เป็นหน้าเว็บไฟล์เดียว
#   python build.py   → index.html       (สำหรับเผยแพร่เป็น Artifact บน claude.ai ไม่มี <html>/<head>)
#                     → docs/index.html  (เว็บเต็มรูปแบบ เปิดในเบราว์เซอร์หรือขึ้น GitHub Pages ได้เลย)
import os

css = open("app.css", encoding="utf-8").read()
body = open("body.html", encoding="utf-8").read()
eng = open("engine.js", encoding="utf-8").read()
app = open("app.js", encoding="utf-8").read()
for tag in ("</script", "</body", "</head", "</html"):
    # ถ้ามีคำเหล่านี้ในโค้ด JS ตัวเว็บหรือ Live Server จะตัดสคริปต์ผิดที่ ให้เขียนเป็น "<\\/body>" แทน
    assert tag not in eng and tag not in app, "ห้ามมีข้อความ " + tag + " ในไฟล์ JS ให้เขียนเป็น <\\/" + tag[2:]

fonts = '<link rel="preconnect" href="https://fonts.googleapis.com">\n<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@600;700&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans+Thai:wght@400;500;600&display=swap">\n'
scripts = ('<script src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"></script>\n'
           '<script id="engine">\n' + eng + '\n</script>\n<script>\n' + app + '\n</script>\n')
title = "<title>ระบบจัดตารางสอนอัตโนมัติ</title>\n"

artifact = title + '<meta name="claude:viewport-fit-sides" content="cover">\n' + fonts + "<style>\n" + css + "</style>\n" + body + "\n" + scripts
open("index.html", "w", encoding="utf-8").write(artifact)

os.makedirs("docs", exist_ok=True)
standalone = ('<!doctype html>\n<html lang="th">\n<head>\n<meta charset="utf-8">\n'
              '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
              + title + fonts + "<style>\nbody{margin:0}\n" + css + "</style>\n</head>\n<body>\n" + body + "\n" + scripts + "</body>\n</html>\n")
open("docs/index.html", "w", encoding="utf-8").write(standalone)
print("built index.html", len(artifact), "· docs/index.html", len(standalone))
