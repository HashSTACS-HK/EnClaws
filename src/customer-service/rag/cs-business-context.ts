export type CSBusinessMetadata = Record<string, unknown>;

export type CSBusinessContext = {
  systemPrompt: string;
  slotQuestion?: string;
};

function objectValue(input: unknown): Record<string, unknown> | null {
  return input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : null;
}

function stringValue(input: unknown): string | null {
  return typeof input === "string" && input.trim() ? input.trim() : null;
}

function firstStringValue(input: Record<string, unknown> | null, keys: string[]): string | null {
  if (!input) {
    return null;
  }
  for (const key of keys) {
    const value = stringValue(input[key]);
    if (value) {
      return value;
    }
  }
  return null;
}

export function resolveCSBusinessContext(metadata?: CSBusinessMetadata): CSBusinessContext | null {
  if (!metadata) {
    return null;
  }

  const business = stringValue(metadata.business);
  const customs = objectValue(metadata.customs);
  if (business === "customs" || customs) {
    const declarationId = firstStringValue(customs, ["declarationId", "orderNo", "orderId"]);
    if (!declarationId) {
      return {
        systemPrompt:
          "Jiumi customs context: the customer is asking about customs declaration status, but no declarationId/order number was provided.",
        slotQuestion: "请提供报关订单号，我帮您查询当前申报状态。",
      };
    }
    return {
      systemPrompt: `Jiumi customs context: declarationId=${declarationId}. Use the customs order query skill; do not guess another order.`,
    };
  }

  const settlement = objectValue(metadata.settlement);
  if (business === "settlement" || settlement) {
    const settlementOrderId = firstStringValue(settlement, [
      "settlementOrderId",
      "orderNo",
      "orderId",
    ]);
    if (!settlementOrderId) {
      return {
        systemPrompt:
          "Jiumi settlement context: the customer is asking about settlement status, but no settlement order number was provided.",
        slotQuestion: "请提供结汇订单号，我帮您查询当前结汇进度。",
      };
    }
    return {
      systemPrompt: `Jiumi settlement context: settlementOrderId=${settlementOrderId}. Use the settlement order query skill; do not guess another order.`,
    };
  }

  return {
    systemPrompt: `Upper app business metadata:\n${JSON.stringify(metadata)}`,
  };
}
