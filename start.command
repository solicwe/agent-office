#!/bin/bash
# Agent Office for macOS: double-click this file to install (first time) and open the window.
cd "$(dirname "$0")" || exit 1
PORT="${PORT:-3000}"

if ! command -v node >/dev/null 2>&1; then
  echo "ต้องติดตั้ง Node.js เวอร์ชัน 20 ขึ้นไปก่อน กำลังเปิดหน้าดาวน์โหลด..."
  open "https://nodejs.org/"
  read -r -p "ติดตั้งเสร็จแล้วดับเบิลคลิกไฟล์นี้อีกครั้ง (กด Enter เพื่อปิด)"
  exit 1
fi

[ -d node_modules ] || npm install --no-fund --no-audit || { read -r -p "ติดตั้งไม่สำเร็จ กด Enter เพื่อปิด"; exit 1; }

if [ ! -f office.local.json ]; then
  npm run setup || exit 1
fi

(sleep 2; open "http://localhost:${PORT}") &
echo "Agent Office: http://localhost:${PORT}  (ปิดหน้าต่างนี้เพื่อหยุด)"
echo "เปิด AI ของคุณในโฟลเดอร์ที่เลือกตอนตั้งค่า แล้วสั่งงานได้เลย"
npm start
