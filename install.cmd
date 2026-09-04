@echo off
rem CodeGraph Manager 一键安装（Windows 双击入口）：Node -> git -> codegraph -> cgm -> 启动
rem 参数透传给 cgm，例如: install.cmd --port 9000
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
pause
