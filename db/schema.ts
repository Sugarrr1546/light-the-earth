import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { Photo, Region } from '../lib/model';

export const visits = sqliteTable('visits', {
  id: text('id').notNull(),
  ownerId: text('owner_id').notNull(),
  region: text('region', { mode: 'json' }).$type<Region>().notNull(),
  status: text('status', { enum: ['visited', 'lived', 'passed', 'wishlist'] }).notNull(),
  visitedOn: text('visited_on').notNull().default(''),
  title: text('title').notNull().default(''),
  notes: text('notes').notNull().default(''),
  tripName: text('trip_name').notNull().default(''),
  photos: text('photos', { mode: 'json' }).$type<Photo[]>().notNull().default([]),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.ownerId, table.id] }),
  index('visits_owner_updated_idx').on(table.ownerId, table.updatedAt),
]);

export const photos = sqliteTable('photos', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id').notNull(),
  objectKey: text('object_key').notNull().unique(),
  filename: text('filename').notNull(),
  contentType: text('content_type').notNull(),
  size: integer('size').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [index('photos_owner_idx').on(table.ownerId)]);
