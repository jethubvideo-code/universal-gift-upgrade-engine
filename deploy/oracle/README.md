# Deploy на Oracle Free ARM (Amsterdam) — шаг за шагом

Движок переезжает с GitHub Actions (цикл раз в 5 минут) на выделенный воркер
ARM: непрерывный мониторинг (обычный цикл 10 сек, при горячем таргете — 500 мс),
апгрейд с минимальной латентностью. Всё бесплатно (Oracle Free Tier).

## Шаг 1. Создать инстанс (один раз, ~5 минут)

1. Зайди на **oracle.com/cloud/free** → аккаунт (Always Free).
2. Регион при регистрации выбирай **Amsterdam (eu-amsterdam-1)**.
3. Compute → Create Instance:
   - Shape: **VM.Standard.A1.Flex** (ARM, бесплатно до 4 OCPU / 24 GB — возьми 2 OCPU / 12 GB)
   - Image: **Ubuntu 22.04** (или 24.04)
   - SSH key: скачай свой ключ (или сгенерируй `ssh-keygen -t ed25519` и вставь публичный)
4. После создания скопируй Public IP.

## Шаг 2. Установить движок (одна команда)

Зайди по SSH: `ssh -i <твой_ключ> ubuntu@<IP>` и запусти:

```bash
sudo bash -c 'curl -fsSL https://raw.githubusercontent.com/jethubvideo-code/universal-gift-upgrade-engine/main/deploy/oracle/install.sh | bash'
```

Скрипт спросит: `BOT_TOKEN` (от @BotFather), `TG_API_HASH` (my.telegram.org),
`OWNER_CHAT_ID` (по умолчанию 8396883978), затем **один раз** покажет публичный
ключ — добавь его в GitHub: репозиторий → Settings → Deploy keys → Add
(нужна галочка **write access**). Нажми Enter — установка завершится.

## Шаг 3. Перелогиниться (2 минуты, один раз)

Сессии шифруются ключом, который хранится только в GitHub Secrets, поэтому
после переезда на VM просто напиши боту **@lvlonebot** → `/login` и пройди
вход (телефон → код → 2FA). Это единственный ручной шаг, дальше — навсегда.

## Шаг 4. Отключить дубли на GitHub Actions

Когда `systemctl status gift-engine` показывает живой цикл — **сообщи агенту**,
чтобы он отключил воркфлоу `engine-cycle` и `bot-poll` в GitHub (иначе движок
будет запущен дважды и может сделать двойной апгрейд). Воркфлоу остаются в
репо как аварийный запас — включаются одной командой.

## Полезное на VM

```bash
journalctl -u gift-engine -f        # живой лог движка
journalctl -u gift-bot -f           # лог бота
systemctl restart gift-engine       # перезапуск
```

Файлы: `/opt/gift-engine` — движок, `/etc/gift-engine.env` — секреты (root only).

## Что стало быстрее

| | GitHub Actions | Oracle VM |
|---|---|---|
| Обычный цикл | каждые 5 мин | каждые 10 сек |
| Горячий таргет | 500 мс внутри цикла | **500 мс постоянно, без прогрева** |
| Апгрейд | раз в 5 мин шанс | мгновенно при готовности |
| Сайт Mini App | 5–15 мин | каждые 3 мин + при каждом цикле |
