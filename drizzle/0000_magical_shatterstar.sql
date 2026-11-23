CREATE TABLE `photos` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`object_key` text NOT NULL,
	`filename` text NOT NULL,
	`content_type` text NOT NULL,
	`size` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `photos_object_key_unique` ON `photos` (`object_key`);--> statement-breakpoint
CREATE INDEX `photos_owner_idx` ON `photos` (`owner_id`);--> statement-breakpoint
CREATE TABLE `visits` (
	`id` text NOT NULL,
	`owner_id` text NOT NULL,
	`region` text NOT NULL,
	`status` text NOT NULL,
	`visited_on` text DEFAULT '' NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`trip_name` text DEFAULT '' NOT NULL,
	`photos` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`owner_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `visits_owner_updated_idx` ON `visits` (`owner_id`,`updated_at`);