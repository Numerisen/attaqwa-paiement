import { z } from 'zod';

/**
 * Schémas de validation Zod pour les endpoints API
 */

// Schéma pour donation checkout
export const donationCheckoutSchema = z.object({
  donationType: z.enum(['quete', 'denier', 'cierge', 'messe'], {
    message: 'donationType must be one of: quete, denier, cierge, messe'
  }),
  amount: z.number()
    .min(100, 'Amount must be at least 100 FCFA')
    .max(100000000, 'Amount exceeds maximum limit')
    .int('Amount must be an integer'),
  description: z.string()
    .max(500, 'Description must not exceed 500 characters')
    .optional(),
  parishId: z.string()
    .min(1, 'parishId cannot be empty')
    .max(200, 'parishId exceeds maximum length')
    .optional(),
  anonymousUid: z.string()
    .regex(/^anonymous_[a-f0-9]{16,32}$/, 'Invalid anonymous UID format')
    .optional(),
});

// Schéma pour checkout standard (BOOK_PART_2, BOOK_PART_3)
export const checkoutSchema = z.object({
  planId: z.enum(['BOOK_PART_2', 'BOOK_PART_3'], {
    message: 'planId must be BOOK_PART_2 or BOOK_PART_3'
  }),
});

// Schéma pour force-complete
export const forceCompleteSchema = z.object({
  token: z.string()
    .min(10, 'Token must be at least 10 characters')
    .max(200, 'Token exceeds maximum length'),
  planId: z.enum(['BOOK_PART_2', 'BOOK_PART_3'], {
    message: 'planId must be BOOK_PART_2 or BOOK_PART_3'
  }),
});

// Schéma pour status (query param)
export const statusQuerySchema = z.object({
  token: z.string()
    .min(10, 'Token must be at least 10 characters')
    .max(200, 'Token exceeds maximum length'),
});

// Schéma pour donations history (query param)
export const donationsHistoryQuerySchema = z.object({
  anonymousUid: z.string()
    .regex(/^anonymous_[a-f0-9]{16,32}$/, 'Invalid anonymous UID format')
    .optional(),
});

/**
 * Helper pour valider et parser les données
 */
export function validateAndParse<T>(schema: z.ZodSchema<T>, data: unknown): { success: true; data: T } | { success: false; error: string } {
  try {
    const parsed = schema.parse(data);
    return { success: true, data: parsed };
  } catch (error) {
    if (error instanceof z.ZodError) {
      const firstError = error.issues[0];
      return { 
        success: false, 
        error: firstError?.message || 'Validation failed' 
      };
    }
    return { success: false, error: 'Invalid request data' };
  }
}

