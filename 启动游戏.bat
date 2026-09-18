@echo off
chcp 65001 >nul
title 无限仙途 - 游戏启动器
cd /d D:\ak\mortal_journey-main

echo ============================================
echo   正在启动「无限仙途」游戏服务器...
echo   请稍候，看到 Local 地址后会自动打开浏览器
echo=============================================
echo.

start "" http://localhost:5173
call npm run dev

echo.
echo 服务器已停止。
pause