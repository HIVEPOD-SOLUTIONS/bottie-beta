CREATE TABLE "nosana_deployments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"deployment_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "nosana_deployments_deployment_idx" ON "nosana_deployments" USING btree ("deployment_id");--> statement-breakpoint
CREATE INDEX "nosana_deployments_user_idx" ON "nosana_deployments" USING btree ("user_id");