@echo off
title Motor WhatsApp SaaS - Painel Novo
color 0B

echo.
echo  ============================================
echo   MOTOR WHATSAPP SAAS - PAINEL NOVO
echo  ============================================
echo.

cd /d "%~dp0"

if not exist ".env.motor.local" (
    echo  Configuracao local nao encontrada.
    echo  Execute primeiro: pnpm runtime:sync
    echo.
    pause
    exit /b 1
)

echo  Este motor atende o painel publicado na Vercel.
echo  Mantenha esta janela aberta. Feche para parar o motor SaaS.
echo.

call pnpm motor:start

echo.
echo  O motor SaaS foi encerrado.
pause
