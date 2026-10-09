import assert from "node:assert/strict";
import test from "node:test";
import { registerAskuserTool } from "../src/tool.ts";
import { renderAgentAnswer, renderBatchAnswer, renderSingleAnswer } from "../src/ui.ts";
import type { AskBatchDetails } from "../src/types.ts";

const plainTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

test("batch formatting keeps agent content compact and UI content detailed", () => {
	const details: AskBatchDetails = {
		cancelled: false,
		answers: [
			{ question: "Name?", type: "text", options: undefined, answer: "Ada" },
			{ question: "Proceed?", type: "confirm", options: undefined, answer: true },
			{ question: "Features?", type: "multiselect", options: ["a", "b"], answer: ["a", "b"] },
			{ question: "Other?", type: "select", options: ["x"], answer: "custom value", custom: true },
		],
	};

	assert.equal(
		renderAgentAnswer(details),
		"1 -> Ada\n2 -> yes\n3 -> a, b\n4 -> custom value",
	);
	assert.equal(
		renderBatchAnswer(details),
		"1. Name? → Ada\n2. Proceed? → yes\n3. Features? → a, b\n4. Other? → (custom) custom value",
	);
	assert.equal(renderSingleAnswer(details.answers[0]), "Ada");
	assert.equal(renderSingleAnswer(details.answers[1]), "yes");
	assert.equal(renderSingleAnswer(details.answers[2]), "a, b");
	assert.equal(renderSingleAnswer(details.answers[3]), "custom value");
});

test("agent content is answer-only while tool UI shows question and answer", async () => {
	let tool: any;
	registerAskuserTool({
		registerTool(definition: unknown) {
			tool = definition;
		},
	} as never);

	const oldHerdrEnv = process.env.HERDR_ENV;
	process.env.HERDR_ENV = "0";
	try {
		const ctx = {
			mode: "tui",
			ui: {
				custom: (factory: (...args: any[]) => any) =>
					new Promise((resolve) => {
						const component = factory(
							{ requestRender() {} },
							plainTheme,
							{ matches: () => false },
							resolve,
						);
						component.handleInput("answer one");
						component.handleInput("\r");
					}),
			},
		};

		const args = { questions: [{ question: "First question?", type: "text" }] };
		const result = await tool.execute("test-call", args, undefined, undefined, ctx);

		assert.equal(result.content[0].text, "1 -> answer one");
		assert.ok(tool.renderResult, "tool must define renderResult instead of exposing agent content in the UI");
		const callText = tool.renderCall(args, plainTheme, {}).render(80).join("\n");
		const rendered = tool.renderResult(result, { expanded: false, isPartial: false }, plainTheme, { args });
		const uiText = rendered.render(80).join("\n");
		assert.match(callText, /First question\?/);
		assert.doesNotMatch(uiText, /First question\?/);
		assert.equal(uiText.trim(), "answer one");
		assert.equal(`${callText}\n${uiText}`.match(/First question\?/g)?.length, 1);
	} finally {
		if (oldHerdrEnv === undefined) delete process.env.HERDR_ENV;
		else process.env.HERDR_ENV = oldHerdrEnv;
	}
});

test("multi-question UI keeps questions out of the call title and in the result", () => {
	let tool: any;
	registerAskuserTool({
		registerTool(definition: unknown) {
			tool = definition;
		},
	} as never);

	const args = {
		questions: [
			{ question: "First question?", type: "text" },
			{ question: "Second question?", type: "confirm" },
		],
	};
	const details: AskBatchDetails = {
		cancelled: false,
		answers: [
			{ question: "First question?", type: "text", options: undefined, answer: "one" },
			{ question: "Second question?", type: "confirm", options: undefined, answer: true },
		],
	};
	const result = { content: [{ type: "text", text: renderAgentAnswer(details) }], details };
	const callText = tool.renderCall(args, plainTheme, {}).render(80).join("\n");
	const resultText = tool
		.renderResult(result, { expanded: false, isPartial: false }, plainTheme, { args })
		.render(80)
		.join("\n");

	assert.match(callText, /Ask User \(2 questions\)/);
	assert.doesNotMatch(callText, /First question\?/);
	assert.match(resultText, /First question\?.*one/);
	assert.match(resultText, /Second question\?.*yes/);
	assert.equal(`${callText}\n${resultText}`.match(/First question\?/g)?.length, 1);
});

test("rejects invalid batches without starting the wizard", async () => {
	let tool: any;
	registerAskuserTool({
		registerTool(definition: unknown) {
			tool = definition;
		},
	} as never);

	let prompted = false;
	const ctx = {
		mode: "tui",
		ui: {
			custom: async () => {
				prompted = true;
				return null;
			},
		},
	};

	const result = await tool.execute(
		"test-call",
		{
			questions: [
				{ question: "   ", type: "text" },
				{ question: "Pick one", type: "select" },
				{ question: "Notes?", type: "text", options: ["a"] },
				{ question: "Color?", type: "select", options: ["r"], default: "r" },
			],
		},
		undefined,
		undefined,
		ctx,
	);

	assert.equal(prompted, false);
	assert.match(result.content[0].text, /questions\[0\]: question text is empty/);
	assert.match(result.content[0].text, /questions\[1\]: type 'select' requires a non-empty options array/);
	assert.match(result.content[0].text, /questions\[2\]: type 'text' does not accept options/);
	assert.match(result.content[0].text, /questions\[3\]: 'default' is only used with type 'text'/);
	const details = result.details as AskBatchDetails;
	assert.equal(details.cancelled, true);
	assert.deepEqual(details.answers, []);
});

test("refuses to prompt outside interactive TUI mode", async () => {
	let tool: any;
	registerAskuserTool({
		registerTool(definition: unknown) {
			tool = definition;
		},
	} as never);

	const result = await tool.execute(
		"test-call",
		{ questions: [{ question: "Proceed?" }] },
		undefined,
		undefined,
		{ mode: "headless" },
	);

	assert.match(result.content[0].text, /only be used in interactive TUI mode/);
	assert.equal((result.details as AskBatchDetails).cancelled, true);
});
