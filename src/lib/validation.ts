import { z } from "zod";
import { Result } from "better-result";
import { ValidationError } from "./errors";

// ============================================================================
// Content Block Schemas
// ============================================================================

const TextBlockSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

const ToolUseBlockSchema = z.object({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
});

const ToolResultBlockSchema = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  content: z.string(),
  is_error: z.boolean().optional(),
});

const ThinkingBlockSchema = z.object({
  type: z.literal("thinking"),
  thinking: z.string(),
  duration_ms: z.number().optional(),
});

const ImageSourceBase64Schema = z.object({
  type: z.literal("base64"),
  media_type: z.string(),
  data: z.string(),
});

const ImageSourceUrlSchema = z.object({
  type: z.literal("url"),
  url: z.string(),
});

const ImageBlockSchema = z.object({
  type: z.literal("image"),
  source: z.union([ImageSourceBase64Schema, ImageSourceUrlSchema]),
  filename: z.string().optional(),
});

const FileBlockSchema = z.object({
  type: z.literal("file"),
  filename: z.string(),
  media_type: z.string().optional(),
  size: z.number().optional(),
});

export const ContentBlockSchema = z.discriminatedUnion("type", [
  TextBlockSchema,
  ToolUseBlockSchema,
  ToolResultBlockSchema,
  ThinkingBlockSchema,
  ImageBlockSchema,
  FileBlockSchema,
]);

// ============================================================================
// Message Input Schemas
// ============================================================================

export const MessageInputSchema = z.object({
  role: z.enum(["user", "assistant", "human"]).transform((val) => (val === "human" ? "user" : val)),
  content: z.union([z.string(), z.array(ContentBlockSchema)]).optional(),
  content_blocks: z.array(ContentBlockSchema).optional(),
  timestamp: z.string().optional(),
  text: z.string().optional(), // Alternative text field
});

// ============================================================================
// Request Schemas
// ============================================================================

// POST /api/sessions/spawn
export const SpawnSessionSchema = z.object({
  prompt: z.string().min(1, "prompt is required"),
  cwd: z.string().min(1, "cwd is required"),
  harness: z.string().default("claude-code"),
  model: z.string().optional(),
  permission_mode: z.enum(["relay", "auto-safe", "auto"]).default("relay"),
});

// POST /api/sessions/live
export const CreateLiveSessionSchema = z.object({
  title: z.string().min(1, "title is required"),
  project_path: z.string().optional(),
  harness_session_id: z.string().optional(),
  claude_session_id: z.string().optional(), // Backwards compatibility
  harness: z.string().optional(),
  model: z.string().optional(),
  repo_url: z.string().url().optional().or(z.literal("")),
  interactive: z.boolean().default(false),
});

// POST /api/sessions/:id/messages
export const PushMessagesSchema = z.object({
  messages: z.array(MessageInputSchema).min(1, "messages array is required"),
});

// POST /api/sessions/:id/tool-results
const ToolResultInputSchema = z.object({
  tool_use_id: z.string(),
  content: z.unknown(),
  is_error: z.boolean().optional(),
  message_index: z.number().optional(),
});

export const PushToolResultsSchema = z.object({
  results: z.array(ToolResultInputSchema).min(1, "results array is required"),
});

// PATCH /api/sessions/:id
export const PatchSessionSchema = z
  .object({
    title: z.string().optional(),
    description: z.string().optional(),
  })
  .refine((data) => data.title !== undefined || data.description !== undefined, {
    message: "At least one field (title or description) is required",
  });

// POST /api/sessions/:id/complete
export const CompleteSessionSchema = z.object({
  final_diff: z.string().optional(),
  summary: z.string().optional(),
});

// GET /api/stats/timeseries query params
export const TimeseriesQuerySchema = z.object({
  stat: z.string().min(1, "stat parameter is required"),
  period: z.enum(["today", "week", "month", "all"]).optional(),
  fill: z
    .string()
    .transform((val) => val === "true")
    .optional(),
});

// Helper for validating optional URL strings (empty string or valid URL)
const optionalUrlString = z
  .string()
  .refine((val) => !val || isValidHttpUrl(val), {
    message: "Invalid URL - must be a valid HTTP(S) URL",
  })
  .optional();

function isValidHttpUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

// POST /api/sessions - FormData schema (for session upload)
export const CreateSessionFormSchema = z.object({
  title: z.string().min(1, "Title is required"),
  description: z.string().optional(),
  claude_session_id: z.string().optional(),
  pr_url: optionalUrlString,
  project_path: z.string().optional(),
  model: z.string().optional(),
  harness: z.string().optional(),
  repo_url: z.string().optional(),
  // Note: session_file, session_data, diff_file, diff_data, review_* fields
  // are handled separately as they can be Files or need special parsing
});

// PUT /api/sessions/:id - FormData schema (for session update)
export const UpdateSessionFormSchema = z.object({
  title: z.string().min(1, "Title is required"),
  description: z.string().optional(),
  claude_session_id: z.string().optional(),
  pr_url: optionalUrlString,
  project_path: z.string().optional(),
  model: z.string().optional(),
  harness: z.string().optional(),
  repo_url: z.string().optional(),
});

// ============================================================================
// Validation Helpers
// ============================================================================

/**
 * Validate JSON request body against a Zod schema.
 * Returns a Result with the parsed data or a ValidationError.
 */
export async function validateJson<T>(
  req: Request,
  schema: z.ZodSchema<T>
): Promise<Result<T, ValidationError>> {
  let body: unknown;

  try {
    body = await req.json();
  } catch {
    return Result.err(
      new ValidationError({
        field: "body",
        message: "Invalid JSON",
      })
    );
  }

  const result = schema.safeParse(body);

  if (!result.success) {
    const firstError = result.error.issues[0];
    const field = firstError?.path.join(".") || "body";
    const message = firstError?.message || "Validation failed";
    const path = firstError?.path as (string | number)[];

    return Result.err(
      new ValidationError({
        field,
        message,
        value: path?.length ? getNestedValue(body, path) : body,
      })
    );
  }

  return Result.ok(result.data);
}

/**
 * Validate FormData against a Zod schema.
 * Converts FormData to an object before validation.
 */
export function validateFormData<T>(
  formData: FormData,
  schema: z.ZodSchema<T>
): Result<T, ValidationError> {
  const data: Record<string, unknown> = {};

  for (const [key, value] of formData.entries()) {
    data[key] = value;
  }

  const result = schema.safeParse(data);

  if (!result.success) {
    const firstError = result.error.issues[0];
    const field = firstError?.path.join(".") || "body";
    const message = firstError?.message || "Validation failed";
    const path = firstError?.path as (string | number)[];

    return Result.err(
      new ValidationError({
        field,
        message,
        value: path?.length ? getNestedValue(data, path) : undefined,
      })
    );
  }

  return Result.ok(result.data);
}

/**
 * Validate query parameters against a Zod schema.
 */
export function validateQueryParams<T>(
  url: URL,
  schema: z.ZodSchema<T>
): Result<T, ValidationError> {
  const params: Record<string, string> = {};

  for (const [key, value] of url.searchParams.entries()) {
    params[key] = value;
  }

  const result = schema.safeParse(params);

  if (!result.success) {
    const firstError = result.error.issues[0];
    const field = firstError?.path.join(".") || "query";
    const message = firstError?.message || "Validation failed";
    const path = firstError?.path as (string | number)[];

    return Result.err(
      new ValidationError({
        field,
        message,
        value: path?.length ? getNestedValue(params, path) : undefined,
      })
    );
  }

  return Result.ok(result.data);
}

/**
 * Get a nested value from an object using a path array.
 */
function getNestedValue(obj: unknown, path: (string | number)[]): unknown {
  let current = obj;
  for (const key of path) {
    if (current === null || current === undefined) {
      return undefined;
    }
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}

// ============================================================================
// Type Exports
// ============================================================================

export type SpawnSession = z.infer<typeof SpawnSessionSchema>;
export type CreateLiveSession = z.infer<typeof CreateLiveSessionSchema>;
export type PushMessages = z.infer<typeof PushMessagesSchema>;
export type PushToolResults = z.infer<typeof PushToolResultsSchema>;
export type PatchSession = z.infer<typeof PatchSessionSchema>;
export type CompleteSession = z.infer<typeof CompleteSessionSchema>;
export type TimeseriesQuery = z.infer<typeof TimeseriesQuerySchema>;
export type CreateSessionForm = z.infer<typeof CreateSessionFormSchema>;
export type UpdateSessionForm = z.infer<typeof UpdateSessionFormSchema>;
