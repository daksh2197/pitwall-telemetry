from __future__ import annotations

import asyncio
import contextlib
import json

import websockets

from pitwall.pipeline import Pipeline, RunConfig
from pitwall.server import encode, stream

CONFIG = RunConfig(seed=3, duration_s=2.0, loss=0.05)


async def with_server(speed: float, clients: int = 1) -> list[list[str]]:
    async def handler(ws: websockets.ServerConnection) -> None:
        await stream(ws, CONFIG, speed)

    async with websockets.serve(handler, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]

        async def read_all() -> list[str]:
            got: list[str] = []
            async with websockets.connect(f"ws://127.0.0.1:{port}") as ws:
                async for message in ws:
                    got.append(str(message))
            return got

        return await asyncio.gather(*(read_all() for _ in range(clients)))


async def test_the_server_sends_exactly_the_messages_the_pipeline_makes() -> None:
    [got] = await with_server(speed=0)
    expected = [encode(m) for m in Pipeline(CONFIG).messages(source="live run")]
    assert got == expected


async def test_two_dashboards_each_get_a_full_run() -> None:
    a, b = await with_server(speed=0, clients=2)
    assert a == b
    assert json.loads(a[0])["type"] == "hello" and json.loads(a[-1])["type"] == "end"


async def test_the_server_waits_for_the_clock_when_paced() -> None:
    loop = asyncio.get_running_loop()
    start = loop.time()
    # speed 8: a 2 s run should take about 0.25 s of real time.
    await with_server(speed=8)
    took = loop.time() - start
    assert 0.2 < took < 1.5


async def test_a_client_that_leaves_early_does_not_hurt_the_server() -> None:
    async def handler(ws: websockets.ServerConnection) -> None:
        with contextlib.suppress(websockets.ConnectionClosed):
            await stream(ws, CONFIG, speed=0)

    async with websockets.serve(handler, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        async with websockets.connect(f"ws://127.0.0.1:{port}") as ws:
            await ws.recv()  # hello
        # And a second client afterwards still gets a complete run.
        async with websockets.connect(f"ws://127.0.0.1:{port}") as ws:
            kinds = [json.loads(m)["type"] async for m in ws]
    assert kinds[0] == "hello" and kinds[-1] == "end"
