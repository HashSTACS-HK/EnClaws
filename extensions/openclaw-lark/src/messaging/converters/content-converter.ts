/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Content converter for Feishu messages.
 *
 * Each message type (text, post, image, etc.) has a dedicated converter
 * function that parses raw JSON content into an AI-friendly text
 * representation plus a list of resource descriptors.
 *
 * This module is a general-purpose message parsing utility — usable
 * from inbound handling, outbound formatting, and skills.
 */

import { converters } from "./index";
import type { ConvertContext, ConvertResult } from "./types";

// Re-export types for convenience
export type { ApiMessageItem, ConvertContext, ConvertResult, ContentConverterFn } from "./types";
export {
  buildConvertContextFromItem,
  extractMentionOpenId,
  resolveMentions,
} from "./content-converter-helpers";

// ---------------------------------------------------------------------------
// Convert
// ---------------------------------------------------------------------------

/**
 * Convert raw message content using the converter for the given message
 * type. Falls back to the "unknown" converter for unrecognised types.
 *
 * Returns a Promise because some converters (e.g. merge_forward) perform
 * async operations. Synchronous converters are awaited transparently.
 */
export async function convertMessageContent(
  raw: string,
  messageType: string,
  ctx: ConvertContext,
): Promise<ConvertResult> {
  const fn = converters.get(messageType) ?? converters.get("unknown");
  if (!fn) {
    return { content: raw, resources: [] };
  }
  const nextCtx = ctx.convertMessageContent ? ctx : { ...ctx, convertMessageContent };
  return fn(raw, nextCtx);
}
