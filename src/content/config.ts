// src/content/config.ts
// Defines content collection schemas for Astro content collections.
import { defineCollection, z } from 'astro:content';

const blog = defineCollection({
  type: 'content',
  schema: z.object({
    title:       z.string(),
    date:        z.date(),
    description: z.string(),
  }),
});

export const collections = { blog };
