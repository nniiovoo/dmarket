import { z } from "zod";

import { carrierCodes } from "@/lib/carriers";

export const SUPPORTED_CHAIN_IDS = [11155111, 80002] as const;
export const PRODUCT_STATUSES = ["active", "inactive", "sold_out"] as const;
export const ORDER_STATUSES = ["Created", "Paid", "Shipped", "Completed", "Cancelled", "Disputed", "Refunded"] as const;

export const addressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, "Invalid Ethereum address")
  .transform((value) => value.toLowerCase());

export const productStatusSchema = z.enum(PRODUCT_STATUSES);
export const orderStatusSchema = z.enum(ORDER_STATUSES);
export const carrierSchema = z.enum(carrierCodes as [string, ...string[]]);

export const productCreateSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).default(""),
  priceWei: z.string().regex(/^[1-9]\d*$/, "Must be positive integer string"),
  chainId: z.number().int().refine((value) => SUPPORTED_CHAIN_IDS.includes(value as (typeof SUPPORTED_CHAIN_IDS)[number]), {
    message: "Unsupported chain"
  }),
  imageUrl: z.string().url().or(z.literal("")).default(""),
  sellerAddress: addressSchema,
  signature: z.string().regex(/^0x[a-fA-F0-9]+$/, "Invalid signature"),
  signedMessage: z.string()
});

export const productUpdateSchema = productCreateSchema
  .partial({
    name: true,
    description: true,
    priceWei: true,
    imageUrl: true,
    chainId: true
  })
  .extend({
    status: productStatusSchema.optional(),
    sellerAddress: addressSchema,
    signature: z.string().regex(/^0x[a-fA-F0-9]+$/, "Invalid signature"),
    signedMessage: z.string()
  });

export const productListQuerySchema = z.object({
  chainId: z.coerce
    .number()
    .int()
    .refine((value) => SUPPORTED_CHAIN_IDS.includes(value as (typeof SUPPORTED_CHAIN_IDS)[number]), {
      message: "Unsupported chain"
    })
    .optional(),
  seller: addressSchema.optional(),
  status: productStatusSchema.default("active"),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0)
});

export const orderListQuerySchema = z
  .object({
    buyer: addressSchema.optional(),
    seller: addressSchema.optional(),
    chainId: z.coerce
      .number()
      .int()
      .refine((value) => SUPPORTED_CHAIN_IDS.includes(value as (typeof SUPPORTED_CHAIN_IDS)[number]), {
        message: "Unsupported chain"
      })
      .optional(),
    status: orderStatusSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).default(0)
  })
  .refine((value) => value.buyer !== undefined || value.seller !== undefined, {
    message: "buyer or seller is required",
    path: ["buyer"]
  });

export const orderDetailParamsSchema = z.object({
  chainId: z.coerce
    .number()
    .int()
    .refine((value) => SUPPORTED_CHAIN_IDS.includes(value as (typeof SUPPORTED_CHAIN_IDS)[number]), {
      message: "Unsupported chain"
    }),
  onChainOrderId: z.string().regex(/^[1-9]\d*$/, "Invalid order id")
});

export const bindEmailSchema = z.object({
  walletAddress: addressSchema,
  email: z.string().email().max(320).refine((value) => !value.includes(":"), "Email cannot contain ':'"),
  signature: z.string().regex(/^0x[a-fA-F0-9]+$/, "Invalid signature"),
  signedMessage: z.string()
});

export const userEmailQuerySchema = z.object({
  address: addressSchema
});

export const shippingUpdateSchema = z.object({
  carrier: carrierSchema,
  trackingNumber: z.string().trim().max(120).refine((value) => !value.includes(":"), "Tracking number cannot contain ':'").default(""),
  shippingNote: z.string().trim().max(500).optional().default(""),
  manualUrl: z.string().url().or(z.literal("")).nullable().optional(),
  sellerAddress: addressSchema,
  signature: z.string().regex(/^0x[a-fA-F0-9]+$/, "Invalid signature"),
  signedMessage: z.string()
});
