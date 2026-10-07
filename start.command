#!/bin/bash
# Agent Office for macOS: double-click this file to install (first time) and open the app.
cd "$(dirname "$0")" || exit 1
PORT="${PORT:-3000}"

if ! command -v node >/dev/null 2>&1; then
  echo "ต้องติดตั้ง Node.js เวอร์ชัน 22 ขึ้นไปก่อน กำลังเปิดหน้าดาวน์โหลด..."
  open "https://nodejs.org/"
  read -r -p "ติดตั้งเสร็จแล้วดับเบิลคลิกไฟล์นี้อีกครั้ง (กด Enter เพื่อปิด)"
  exit 1
fi
if [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  echo "Node.js ต้องเป็นเวอร์ชัน 22 ขึ้นไป (ตอนนี้ $(node -v)) กำลังเปิดหน้าดาวน์โหลด..."
  open "https://nodejs.org/"
  read -r -p "กด Enter เพื่อปิด"
  exit 1
fi

[ -d node_modules ] || npm install --no-fund --no-audit || { read -r -p "ติดตั้งไม่สำเร็จ กด Enter เพื่อปิด"; exit 1; }
[ -f .env ] || cp .env.example .env

(sleep 3; open "http://localhost:${PORT}") &
echo "กำลังเปิด Agent Office ที่ http://localhost:${PORT}  (ปิดหน้าต่างนี้เพื่อหยุด)"
npm start
