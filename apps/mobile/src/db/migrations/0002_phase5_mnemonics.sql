CREATE TABLE `memory_palaces` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`loci` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`_pulled_at` integer
);
--> statement-breakpoint
CREATE TABLE `mnemonics` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`card_id` text,
	`node_id` text,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`content` text NOT NULL,
	`palace_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`_pulled_at` integer
);
--> statement-breakpoint
CREATE INDEX `mnemonics_card` ON `mnemonics` (`card_id`);--> statement-breakpoint
CREATE INDEX `mnemonics_node` ON `mnemonics` (`node_id`);