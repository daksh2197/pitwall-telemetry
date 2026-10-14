"""Serve the pipeline's messages to dashboards over a WebSocket.

Every connected dashboard gets its own run from the start, paced against the real clock: a
batch is sent when the simulated time of that batch has passed in real time. `speed` makes it
faster or slower. With `speed=0` it does not wait at all, which is what the tests use.

The server only sends. Anything a client sends is ignored.
"""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Callable

import websockets
from websockets.asyncio.server import ServerConnection

from pitwall.pipeline import Pipeline, RunConfig

DEFAULT_PORT = 8765


def encode(message: dict[str, object]) -> str:
    return json.dumps(message, separators=(",", ":"))


async def stream(
    ws: ServerConnection,
    config: RunConfig,
    speed: float,
    on_done: Callable[[], None] | None = None,
) -> None:
    pipeline = Pipeline(config)
    started = time.monotonic()
    messages = pipeline.messages(source="live run")
    try:
        for message in messages:
            if speed > 0 and message["type"] != "hello":
                due = started + message["rx_ms"] / 1000 / speed
                delay = due - time.monotonic()
                if delay > 0:
                    await asyncio.sleep(delay)
            await ws.send(encode(message))
            await asyncio.sleep(0)  # let other connections run between batches
    finally:
        messages.close()
        if on_done:
            on_done()


async def serve(
    config: RunConfig,
    host: str = "127.0.0.1",
    port: int = DEFAULT_PORT,
    speed: float = 1.0,
) -> None:
    async def handler(ws: ServerConnection) -> None:
        try:
            await stream(ws, config, speed)
        except websockets.ConnectionClosed:
            return

    async with websockets.serve(handler, host, port):
        print(f"pit wall listening on ws://{host}:{port}  (Ctrl-C to stop)")
        await asyncio.get_running_loop().create_future()
