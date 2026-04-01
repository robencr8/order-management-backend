-- DropIndex
DROP INDEX "payment_attempts_provider_provider_reference_idx";

-- AlterTable
ALTER TABLE "payment_attempts" ADD COLUMN "failure_reason" TEXT;
ALTER TABLE "payment_attempts" ADD COLUMN "metadata_json" TEXT;
ALTER TABLE "payment_attempts" ADD COLUMN "payment_type" TEXT;

-- CreateIndex
CREATE INDEX "payment_attempts_order_id_idx" ON "payment_attempts"("order_id");

-- CreateIndex
CREATE INDEX "payment_attempts_status_idx" ON "payment_attempts"("status");

-- CreateIndex
CREATE INDEX "payment_attempts_provider_status_idx" ON "payment_attempts"("provider", "status");
