@echo off
chcp 65001 >nul
rem 宮廟雲 入門版：開機自動執行（放進「工作排程器」的「登入時」）
cd /d "%~dp0"
set DATA=D:\TempleData
if not exist "%DATA%" set DATA=%~dp0data
start "" /min node\node.exe server.js --data "%DATA%" --port 8080
timeout /t 3 /nobreak >nul
start "" msedge.exe --kiosk http://127.0.0.1:8080 --edge-kiosk-type=fullscreen --no-first-run
