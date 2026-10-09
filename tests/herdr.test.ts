import assert from "node:assert/strict";
import test from "node:test";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { clearAskMetadata, isHerdrEnv, reportAskMetadata, setHerdrBlocked } from "../src/herdr.ts";

test("metadata requests resolve when Herdr keeps the socket open", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "pi-ask-herdr-"));
	const socketPath = path.join(dir, "herdr.sock");
	const requests: Array<{ method: string; tokens: Record<string, string | null> }> = [];
	const server = net.createServer((socket) => {
		let buffer = "";
		socket.on("data", (data) => {
			buffer += data.toString("utf8");
			for (const line of buffer.split("\n").slice(0, -1)) {
				const request = JSON.parse(line) as {
					id: string;
					method: string;
					params: { tokens: Record<string, string | null> };
				};
				requests.push({ method: request.method, tokens: request.params.tokens });
				// Deliberately keep the connection open: this is how the Herdr RPC
				// listener behaves for a successful request.
				socket.write(JSON.stringify({ id: request.id, result: { ok: true } }) + "\n");
			}
			buffer = buffer.slice(buffer.lastIndexOf("\n") + 1);
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => resolve());
	});

	const oldEnv = {
		herdr: process.env.HERDR_ENV,
		socket: process.env.HERDR_SOCKET_PATH,
		pane: process.env.HERDR_PANE_ID,
	};
	process.env.HERDR_ENV = "1";
	process.env.HERDR_SOCKET_PATH = socketPath;
	process.env.HERDR_PANE_ID = "pane-test";
	try {
		await Promise.race([
			reportAskMetadata(["Pick a database"]),
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error("request did not resolve")), 500)),
		]);
		await clearAskMetadata();
		assert.deepEqual(requests, [
			{ method: "pane.report_metadata", tokens: { ask: "❓ Pick a database", ask_count: null } },
			{ method: "pane.report_metadata", tokens: { ask: null, ask_count: null } },
		]);
	} finally {
		if (oldEnv.herdr === undefined) delete process.env.HERDR_ENV;
		else process.env.HERDR_ENV = oldEnv.herdr;
		if (oldEnv.socket === undefined) delete process.env.HERDR_SOCKET_PATH;
		else process.env.HERDR_SOCKET_PATH = oldEnv.socket;
		if (oldEnv.pane === undefined) delete process.env.HERDR_PANE_ID;
		else process.env.HERDR_PANE_ID = oldEnv.pane;
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(dir, { recursive: true, force: true });
	}
});

test("metadata reporting never throws when the Herdr socket is unreachable", async () => {
	const oldSocket = process.env.HERDR_SOCKET_PATH;
	process.env.HERDR_SOCKET_PATH = path.join(tmpdir(), "pi-ask-herdr-definitely-missing", "herdr.sock");
	try {
		await reportAskMetadata(["Pick a database"]);
		await clearAskMetadata();
	} finally {
		if (oldSocket === undefined) delete process.env.HERDR_SOCKET_PATH;
		else process.env.HERDR_SOCKET_PATH = oldSocket;
	}
});

test("metadata requests resolve instead of hanging when Herdr stays silent", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "pi-ask-herdr-"));
	const socketPath = path.join(dir, "herdr.sock");
	// Accept connections but never respond, like a wedged daemon.
	// Track server-side sockets: the client destroys its end on timeout,
	// but the server end can linger half-open and server.close() waits for it.
	const sockets = new Set<net.Socket>();
	const server = net.createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => resolve());
	});

	const oldSocket = process.env.HERDR_SOCKET_PATH;
	process.env.HERDR_SOCKET_PATH = socketPath;
	try {
		await Promise.race([
			(async () => {
				await reportAskMetadata(["Pick a database"]);
				await clearAskMetadata();
			})(),
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error("metadata hung past the socket timeout")), 5000),
			),
		]);
	} finally {
		if (oldSocket === undefined) delete process.env.HERDR_SOCKET_PATH;
		else process.env.HERDR_SOCKET_PATH = oldSocket;
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(dir, { recursive: true, force: true });
	}
});

test("blocked-state emission reports through the event bus and never throws", () => {
	const emitted: Array<{ name: string; payload: unknown }> = [];
	setHerdrBlocked(
		{
			events: {
				emit(name: string, payload: unknown) {
					emitted.push({ name, payload });
				},
			},
		} as never,
		true,
		"ask_user",
	);
	assert.deepEqual(emitted, [{ name: "herdr:blocked", payload: { active: true, label: "ask_user" } }]);

	// A throwing emitter must not break prompting (unless debugging).
	setHerdrBlocked(
		{
			events: {
				emit() {
					throw new Error("boom");
				},
			},
		} as never,
		false,
	);
});

test("isHerdrEnv requires all three Herdr variables", () => {
	const oldEnv = {
		herdr: process.env.HERDR_ENV,
		socket: process.env.HERDR_SOCKET_PATH,
		pane: process.env.HERDR_PANE_ID,
	};
	try {
		delete process.env.HERDR_ENV;
		delete process.env.HERDR_SOCKET_PATH;
		delete process.env.HERDR_PANE_ID;
		assert.equal(isHerdrEnv(), false);
		process.env.HERDR_ENV = "1";
		process.env.HERDR_SOCKET_PATH = "/tmp/herdr.sock";
		assert.equal(isHerdrEnv(), false);
		process.env.HERDR_PANE_ID = "pane-1";
		assert.equal(isHerdrEnv(), true);
		process.env.HERDR_ENV = "0";
		assert.equal(isHerdrEnv(), false);
	} finally {
		if (oldEnv.herdr === undefined) delete process.env.HERDR_ENV;
		else process.env.HERDR_ENV = oldEnv.herdr;
		if (oldEnv.socket === undefined) delete process.env.HERDR_SOCKET_PATH;
		else process.env.HERDR_SOCKET_PATH = oldEnv.socket;
		if (oldEnv.pane === undefined) delete process.env.HERDR_PANE_ID;
		else process.env.HERDR_PANE_ID = oldEnv.pane;
	}
});
