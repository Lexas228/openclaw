#!/usr/bin/env python3
"""
Диагностический клиент OpenClaw gateway через WebSocket.

Подключается к gateway (напрямую или через SSH-туннель),
проходит хэндшейк, отправляет сообщение в чат и логирует
ВСЕ входящие/исходящие WebSocket-фреймы в JSON-файл для анализа.

Использование:
  # Напрямую (gateway доступен локально):
  python ws_debug.py --port 18789 --message "покажи содержимое текущей директории"

  # Через SSH-туннель (gateway на удалённом сервере):
  ssh -L 18789:127.0.0.1:18789 user@server  # в отдельном терминале
  python ws_debug.py --port 18789 --message "покажи содержимое текущей директории"

  # С токеном авторизации:
  python ws_debug.py --port 18789 --token "my-secret-token" --message "ls -la"

  # Подключиться к существующей сессии:
  python ws_debug.py --port 18789 --session-key "agent:main:fleet-abc123"

  # Только слушать события (не отправлять сообщение):
  python ws_debug.py --port 18789 --listen-only

Лог сохраняется в ws_debug_YYYY-MM-DDTHH-MM-SS.json
"""

import argparse
import asyncio
import json
import os
import signal
import sys
import uuid
from datetime import datetime, timezone

try:
    import websockets
except ImportError:
    print("Нужен пакет websockets: pip install websockets")
    sys.exit(1)


# ─── Настройки протокола ─────────────────────────────────────────────
PROTOCOL_VERSION = 3
# client.id ОБЯЗАН быть из enum: webchat-ui, openclaw-control-ui, webchat,
# cli, gateway-client, openclaw-macos, openclaw-ios, openclaw-android,
# node-host, test, fingerprint, openclaw-probe
CLIENT_ID = "gateway-client"
CLIENT_DISPLAY_NAME = "WS Debug Tool"
CLIENT_VERSION = "1.0.0"
# client.mode ОБЯЗАН быть из enum: webchat, cli, ui, backend, node, probe, test
CLIENT_MODE = "backend"


def ts_now() -> str:
    """ISO timestamp для лога."""
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


class GatewayDebugClient:
    """Минимальный WebSocket-клиент для отладки gateway."""

    def __init__(self, uri: str, auth_token: str | None, auth_password: str | None,
                 session_key: str | None, message: str | None, listen_only: bool,
                 verbose_on: bool, log_file: str):
        self.uri = uri
        self.auth_token = auth_token
        self.auth_password = auth_password
        self.session_key = session_key
        self.message = message
        self.listen_only = listen_only
        self.verbose_on = verbose_on
        self.log_file = log_file

        self.ws = None
        self.request_id = 0
        self.pending: dict[str, asyncio.Future] = {}
        self.log_entries: list[dict] = []
        self.connected = asyncio.Event()
        self.done = asyncio.Event()

    # ─── Логирование ──────────────────────────────────────────────

    def _log(self, direction: str, data: dict | list | str | None):
        """Записать фрейм в лог (direction: 'recv' | 'send' | 'info' | 'recv_raw').
        data может быть dict, list или str — всё сериализуется в лог."""
        if data is not None and not isinstance(data, (dict, list)):
            data = {"_value": str(data)}
        elif data is None:
            data = {}
        entry = {
            "ts": ts_now(),
            "dir": direction,
            "data": data,
        }
        self.log_entries.append(entry)

        # Компактный вывод в консоль
        if direction == "info":
            msg = data.get("message", data) if isinstance(data, dict) else data
            print(f"  ℹ️  {msg}")
        elif direction == "recv_raw":
            print(f"  ⬇️  RAW  ({data.get('_len', 0)} chars)")
        elif direction == "send":
            method = data.get("method", "") if isinstance(data, dict) else ""
            print(f"  ⬆️  SEND  {method or (data.get('type', '?') if isinstance(data, dict) else '?')}  id={(data.get('id', '-') if isinstance(data, dict) else '-')}")
        elif isinstance(data, dict):
            frame_type = data.get("type", "?")
            event = data.get("event", "")
            method = data.get("method", "")
            ok = data.get("ok")

            if frame_type == "event":
                payload = data.get("payload", {})
                state = payload.get("state", "") if isinstance(payload, dict) else ""
                session = payload.get("sessionKey", "") if isinstance(payload, dict) else ""
                stream = payload.get("stream", "") if isinstance(payload, dict) else ""
                extra = ""
                if state:
                    extra += f" state={state}"
                if stream:
                    extra += f" stream={stream}"
                if session:
                    extra += f" session={session}"
                print(f"  ⬇️  EVENT {event}{extra}")
            elif frame_type == "res":
                res_id = data.get("id", "?")
                status = "OK" if ok else "ERR"
                print(f"  ⬇️  RES   id={res_id} {status}")
            else:
                print(f"  ⬇️  {frame_type}")
        else:
            print(f"  ⬇️  RECV  (non-dict)")

    def _maybe_flush(self, msg_count: int, force: bool = False):
        """Периодически сбрасывать лог на диск (каждые 10 сообщений)."""
        if force or msg_count > 0 and msg_count % 10 == 0:
            self._save_log(silent=True)

    def _save_log(self, silent: bool = False):
        """Сохранить лог в файл."""
        with open(self.log_file, "w", encoding="utf-8") as f:
            json.dump(self.log_entries, f, indent=2, ensure_ascii=False)
        if not silent:
            print(f"\n📁 Лог сохранён: {self.log_file} ({len(self.log_entries)} записей)")

    # ─── Транспорт ────────────────────────────────────────────────

    async def _send(self, frame: dict):
        """Отправить JSON-фрейм."""
        self._log("send", frame)
        await self.ws.send(json.dumps(frame))

    async def _request(self, method: str, params: dict, timeout: float = 30.0) -> dict:
        """Отправить запрос и дождаться ответа."""
        self.request_id += 1
        req_id = str(self.request_id)

        frame = {
            "type": "req",
            "id": req_id,
            "method": method,
            "params": params,
        }

        future = asyncio.get_event_loop().create_future()
        self.pending[req_id] = future

        await self._send(frame)

        try:
            result = await asyncio.wait_for(future, timeout=timeout)
            return result
        except asyncio.TimeoutError:
            self.pending.pop(req_id, None)
            raise TimeoutError(f"Таймаут запроса: {method}")

    # ─── Хэндшейк ────────────────────────────────────────────────

    async def _do_connect(self):
        """Отправить connect-запрос (вызывается после connect.challenge)."""
        params = {
            "minProtocol": PROTOCOL_VERSION,
            "maxProtocol": PROTOCOL_VERSION,
            "client": {
                "id": CLIENT_ID,
                "displayName": CLIENT_DISPLAY_NAME,
                "version": CLIENT_VERSION,
                "platform": sys.platform,
                "mode": CLIENT_MODE,
            },
            "caps": ["tool-events"],
            "role": "operator",
            "scopes": [
                "operator.read",
                "operator.write",
                "operator.admin",
                "operator.approvals",
            ],
        }

        if self.auth_token:
            params["auth"] = {"token": self.auth_token}
        elif self.auth_password:
            params["auth"] = {"password": self.auth_password}

        result = await self._request("connect", params)

        if result.get("type") == "hello-ok":
            server = result.get("server", {})
            version = server.get("version", "?")
            host = server.get("host", "?")
            self._log("info", {"message": f"Подключён к gateway v{version} на {host}"})
            self.connected.set()
        else:
            self._log("info", {"message": f"Неожиданный ответ на connect: {result}"})

    # ─── Обработка входящих сообщений ─────────────────────────────

    async def _recv_loop(self):
        """Цикл приёма сообщений. Все события гарантированно пишутся в лог."""
        msg_count = 0
        try:
            async for raw in self.ws:
                msg_count += 1
                # 1. Сразу логируем сырые данные (полностью, без обрезки)
                raw_str = raw if isinstance(raw, str) else raw.decode("utf-8", errors="replace")
                self._log("recv_raw", {"_raw": raw_str, "_len": len(raw_str)})

                # 2. Парсим и логируем структурированный фрейм
                try:
                    frame = json.loads(raw_str)
                except json.JSONDecodeError as e:
                    self._log("recv", {"_parse_error": str(e), "raw": raw_str})
                    self._maybe_flush(msg_count)
                    continue

                # Фрейм может быть list/dict — логируем как есть
                self._log("recv", frame if isinstance(frame, dict) else {"_parsed": frame})

                frame_type = frame.get("type") if isinstance(frame, dict) else None

                try:
                    self._process_frame(frame, frame_type)
                except Exception as e:
                    self._log("info", {"message": f"Ошибка обработки фрейма: {e}"})

                self._maybe_flush(msg_count)

        except websockets.exceptions.ConnectionClosed as e:
            self._log("info", {"message": f"Соединение закрыто: {e}"})
        finally:
            self._maybe_flush(msg_count, force=True)

    def _process_frame(self, frame: dict, frame_type: str | None):
        """Обработать один фрейм (вынесено для изоляции исключений)."""
        if not isinstance(frame, dict):
            return
        payload = frame.get("payload", {}) if isinstance(frame.get("payload"), dict) else {}

        if frame_type == "event":
            event = frame.get("event")
            if event == "connect.challenge":
                asyncio.create_task(self._do_connect())
            elif event == "chat":
                state = payload.get("state")
                run_id = payload.get("runId", "")
                msg = payload.get("message", {})
                content = msg.get("content", []) if isinstance(msg, dict) else []
                text = ""
                for block in (content if isinstance(content, list) else []):
                    if isinstance(block, dict) and block.get("type") == "text":
                        text = block.get("text", "")
                if state == "delta":
                    preview = text[:80] + "..." if len(text) > 80 else text
                    print(f"        💬 delta [{run_id[:8]}]: {preview}")
                elif state == "final":
                    print(f"        ✅ final [{run_id[:8]}]: {text[:200]}")
                    self._log("info", {"message": "Ответ получен (final)"})
                    if not self.listen_only:
                        self.done.set()
                elif state == "error":
                    err = payload.get("errorMessage", "unknown error")
                    print(f"        ❌ error [{run_id[:8]}]: {err}")
                    if not self.listen_only:
                        self.done.set()
            elif event == "agent":
                stream = payload.get("stream")
                data = payload.get("data", {}) if isinstance(payload.get("data"), dict) else {}
                if stream == "tool":
                    name = data.get("name", "?")
                    phase = data.get("phase", "?")
                    args = data.get("args", {})
                    path = args.get("path", args.get("command", "")) if isinstance(args, dict) else ""
                    preview = str(path)[:100]
                    backup_path = data.get("beforeBackupPath")
                    backup_size = data.get("beforeSize")
                    backup_info = ""
                    if backup_path is not None:
                        backup_info = f" backup={backup_path} ({backup_size} bytes)"
                    result_info = ""
                    if phase == "result":
                        result_raw = data.get("result")
                        is_err = data.get("isError", False)
                        if result_raw is not None:
                            result_str = str(result_raw)[:300]
                            result_info = f"\n              {'❌' if is_err else '📄'} result: {result_str}"
                        else:
                            result_info = "\n              ⚠️  result: (отсутствует)"
                    print(f"        🔧 tool {name} [{phase}]: {preview}{backup_info}{result_info}")
                elif stream == "lifecycle":
                    phase = data.get("phase", "?")
                    print(f"        🔄 lifecycle: {phase}")
            elif event == "exec.approval.requested":
                req = payload.get("request", {}) if isinstance(payload.get("request"), dict) else {}
                cmd = req.get("command", "?")
                aid = payload.get("id", "?")
                print(f"        🛡️  APPROVAL NEEDED: {cmd}")
                print(f"           id={aid}")
                asyncio.create_task(self._auto_approve(aid))
            elif event == "tick":
                pass
        elif frame_type == "res":
            req_id = frame.get("id")
            future = self.pending.pop(str(req_id), None)
            if future and not future.done():
                ok = frame.get("ok", False)
                if ok:
                    future.set_result(frame.get("payload", {}))
                else:
                    error = frame.get("error", {}) if isinstance(frame.get("error"), dict) else {}
                    msg = error.get("message", "unknown error")
                    future.set_exception(Exception(msg))

    async def _auto_approve(self, approval_id: str):
        """Автоматически одобрить exec-запрос (для дебага)."""
        try:
            await self._request("exec.approval.resolve", {
                "id": approval_id,
                "decision": "allow-once",
            })
            print(f"        ✅ auto-approved: {approval_id}")
        except Exception as e:
            print(f"        ❌ approve failed: {e}")

    # ─── Основной поток ──────────────────────────────────────────

    async def run(self):
        """Подключиться, отправить сообщение, ждать ответа."""
        print(f"🔌 Подключение к {self.uri} ...")

        try:
            self.ws = await websockets.connect(
                self.uri,
                additional_headers={"Origin": "debug-python-client"},
                max_size=10 * 1024 * 1024,  # 10 MB
                ping_interval=30,
                ping_timeout=10,
            )
        except Exception as e:
            print(f"❌ Не удалось подключиться: {e}")
            self._save_log()
            return

        # Запускаем приёмник
        recv_task = asyncio.create_task(self._recv_loop())

        # Ждём хэндшейка
        try:
            await asyncio.wait_for(self.connected.wait(), timeout=15)
        except asyncio.TimeoutError:
            print("❌ Таймаут хэндшейка (15с)")
            self._save_log()
            return

        # Определяем session key
        if not self.session_key:
            # Получаем default agent id
            try:
                agents = await self._request("agents.list", {})
                default_id = agents.get("defaultId", "main")
                self._log("info", {"message": f"Default agent: {default_id}"})
            except Exception:
                default_id = "main"

            self.session_key = f"agent:{default_id}:debug-{uuid.uuid4().hex[:12]}"
            self._log("info", {"message": f"Создана сессия: {self.session_key}"})

        print(f"📋 Session key: {self.session_key}")

        # Включаем verbose чтобы видеть tool events
        if self.verbose_on:
            try:
                await self._request("sessions.patch", {
                    "key": self.session_key,
                    "verboseLevel": "on",
                })
                self._log("info", {"message": "verbose=on для сессии"})
            except Exception as e:
                self._log("info", {"message": f"sessions.patch не удался: {e}"})

        if self.listen_only:
            print("👂 Режим прослушивания. Ctrl+C для выхода.\n")
            try:
                await recv_task
            except asyncio.CancelledError:
                pass
        else:
            # Загружаем историю
            try:
                history = await self._request("chat.history", {
                    "sessionKey": self.session_key,
                    "limit": 10,
                })
                msgs = history.get("messages", [])
                self._log("info", {"message": f"История: {len(msgs)} сообщений"})
                if msgs:
                    print(f"📜 Загружено {len(msgs)} сообщений из истории")
            except Exception as e:
                self._log("info", {"message": f"Не удалось загрузить историю: {e}"})

            # Отправляем сообщение
            if self.message:
                idempotency_key = f"debug-{uuid.uuid4().hex[:16]}"
                print(f"\n📤 Отправка: \"{self.message}\"")
                print(f"   idempotencyKey: {idempotency_key}\n")

                try:
                    result = await self._request("chat.send", {
                        "sessionKey": self.session_key,
                        "message": self.message,
                        "idempotencyKey": idempotency_key,
                    }, timeout=60)
                    run_id = result.get("runId", "?")
                    status = result.get("status", "?")
                    self._log("info", {"message": f"chat.send OK: runId={run_id}, status={status}"})
                except Exception as e:
                    print(f"❌ chat.send ошибка: {e}")
                    self._save_log()
                    return

                # Ждём final/error или таймаут
                print("⏳ Жду ответа (таймаут 5 мин)...\n")
                try:
                    await asyncio.wait_for(self.done.wait(), timeout=300)
                except asyncio.TimeoutError:
                    print("⏰ Таймаут ожидания ответа (5 мин)")

            # Даём ещё немного времени на поздние события
            await asyncio.sleep(2)

        # Закрываем
        recv_task.cancel()
        try:
            await recv_task
        except asyncio.CancelledError:
            pass
        await self.ws.close()
        self._save_log()


def main():
    parser = argparse.ArgumentParser(
        description="Диагностика WebSocket-протокола OpenClaw gateway",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("--host", default="127.0.0.1", help="Хост gateway (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=18789, help="Порт gateway (default: 18789)")
    parser.add_argument("--token", help="Auth token для gateway")
    parser.add_argument("--password", help="Auth password для gateway")
    parser.add_argument("--session-key", help="Существующий session key (иначе создаст новый)")
    parser.add_argument("--message", "-m", help="Сообщение для отправки в чат")
    parser.add_argument("--listen-only", action="store_true", help="Только слушать, не отправлять")
    parser.add_argument("--no-verbose", action="store_true", help="Не включать verbose (tool events)")
    parser.add_argument("--log", help="Путь к файлу лога (default: auto)")

    args = parser.parse_args()

    if not args.message and not args.listen_only:
        parser.error("Укажите --message или --listen-only")

    uri = f"ws://{args.host}:{args.port}"
    log_file = args.log or f"ws_debug_{datetime.now().strftime('%Y-%m-%dT%H-%M-%S')}.json"

    client = GatewayDebugClient(
        uri=uri,
        auth_token=args.token,
        auth_password=args.password,
        session_key=args.session_key,
        message=args.message,
        listen_only=args.listen_only,
        verbose_on=not args.no_verbose,
        log_file=log_file,
    )

    # Graceful shutdown по Ctrl+C
    loop = asyncio.new_event_loop()

    def handle_sigint():
        print("\n🛑 Прерывание...")
        client.done.set()

    loop.add_signal_handler(signal.SIGINT, handle_sigint)

    try:
        loop.run_until_complete(client.run())
    finally:
        loop.close()


if __name__ == "__main__":
    main()
