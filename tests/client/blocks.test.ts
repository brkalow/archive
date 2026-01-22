import { describe, test, expect } from "bun:test";
import { renderContentBlocks, buildToolResultMap } from "../../src/client/blocks";
import type { ContentBlock } from "../../src/db/schema";

describe("blocks", () => {
  describe("renderContentBlocks", () => {
    describe("command block rendering", () => {
      test("renders command output inside collapsed block", () => {
        const blocks: ContentBlock[] = [
          {
            type: "text",
            text: '<command-name>/context</command-name>\n<local-command-stdout>## Context Usage\n\n**Model:** claude-opus-4-5\n**Tokens:** 99.4k / 200.0k (50%)</local-command-stdout>',
          },
        ];

        const result = renderContentBlocks(blocks, buildToolResultMap([]));

        // Should render as a command block, not a regular text block
        expect(result).toContain("command-block");
        expect(result).toContain("/context");
        // Command output should be inside the block
        expect(result).toContain("Context Usage");
        expect(result).toContain("Tokens:");
      });

      test("extracts command output before stripping system tags", () => {
        // This tests the fix: extractCommandInfo must run BEFORE stripSystemTags
        // because <local-command-stdout> would otherwise be stripped
        const blocks: ContentBlock[] = [
          {
            type: "text",
            text: '<command-name>/test</command-name>\n<local-command-stdout>Test output here</local-command-stdout>',
          },
        ];

        const result = renderContentBlocks(blocks, buildToolResultMap([]));

        expect(result).toContain("command-block");
        expect(result).toContain("Test output here");
      });

      test("renders command block without output", () => {
        const blocks: ContentBlock[] = [
          {
            type: "text",
            text: "<command-name>/help</command-name>",
          },
        ];

        const result = renderContentBlocks(blocks, buildToolResultMap([]));

        expect(result).toContain("command-block");
        expect(result).toContain("/help");
      });

      test("strips system tags from remaining content in command blocks", () => {
        const blocks: ContentBlock[] = [
          {
            type: "text",
            text: '<command-name>/foo</command-name>\n<local-command-stdout>output</local-command-stdout>\n<system-reminder>Should be stripped</system-reminder>\nVisible content',
          },
        ];

        const result = renderContentBlocks(blocks, buildToolResultMap([]));

        expect(result).toContain("Visible content");
        expect(result).not.toContain("Should be stripped");
        expect(result).not.toContain("system-reminder");
      });
    });

    describe("system tag stripping", () => {
      test("strips system-reminder tags from text blocks", () => {
        const blocks: ContentBlock[] = [
          {
            type: "text",
            text: "Hello world\n<system-reminder>This should not appear</system-reminder>\nGoodbye",
          },
        ];

        const result = renderContentBlocks(blocks, buildToolResultMap([]));

        expect(result).toContain("Hello world");
        expect(result).toContain("Goodbye");
        expect(result).not.toContain("This should not appear");
        expect(result).not.toContain("system-reminder");
      });

      test("strips local-command-stdout when not paired with command-name", () => {
        const blocks: ContentBlock[] = [
          {
            type: "text",
            text: "Some text\n<local-command-stdout>orphaned output</local-command-stdout>\nMore text",
          },
        ];

        const result = renderContentBlocks(blocks, buildToolResultMap([]));

        expect(result).toContain("Some text");
        expect(result).toContain("More text");
        expect(result).not.toContain("orphaned output");
        expect(result).not.toContain("local-command-stdout");
      });

      test("returns empty string for text blocks with only system tags", () => {
        const blocks: ContentBlock[] = [
          {
            type: "text",
            text: "<system-reminder>Only system content</system-reminder>",
          },
        ];

        const result = renderContentBlocks(blocks, buildToolResultMap([]));

        expect(result.trim()).toBe("");
      });
    });
  });
});
