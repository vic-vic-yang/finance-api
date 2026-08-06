-- Give automatic deposits an explicit period identity. The nullable column keeps
-- all manually-created/imported bills outside this uniqueness rule.
ALTER TABLE "Bill"
  ADD COLUMN "autoDepositPeriod" TIMESTAMP(3);

-- Legacy automatic deposits are the only bills written with both noteDekVer=0
-- and an empty noteCipher. Keep the oldest row for each account/period.
CREATE TEMP TABLE "_auto_deposit_duplicates" ON COMMIT DROP AS
WITH ranked AS (
  SELECT
    b."id",
    b."accountId",
    b."amount",
    ROW_NUMBER() OVER (
      PARTITION BY b."accountId", b."date"
      ORDER BY b."createdAt", b."id"
    ) AS row_number
  FROM "Bill" b
  WHERE b."type" = 'income'
    AND b."noteDekVer" = 0
    AND OCTET_LENGTH(b."noteCipher") = 0
)
SELECT "id", "accountId", "amount"
FROM ranked
WHERE row_number > 1;

-- Every duplicate insert also incremented the stored balance, so reverse those
-- increments in the same migration before removing the extra bills.
UPDATE "Account" a
SET "balance" = a."balance" - duplicates.total
FROM (
  SELECT "accountId", SUM("amount") AS total
  FROM "_auto_deposit_duplicates"
  GROUP BY "accountId"
) duplicates
WHERE a."id" = duplicates."accountId";

DELETE FROM "Bill" b
USING "_auto_deposit_duplicates" duplicates
WHERE b."id" = duplicates."id";

-- Backfill the surviving legacy rows so retries after deployment also collide
-- with the database uniqueness boundary.
UPDATE "Bill" b
SET
  "autoDepositPeriod" = b."date",
  "source" = 'auto_deposit'
WHERE b."type" = 'income'
  AND b."noteDekVer" = 0
  AND OCTET_LENGTH(b."noteCipher") = 0;

CREATE UNIQUE INDEX "Bill_accountId_autoDepositPeriod_key"
  ON "Bill"("accountId", "autoDepositPeriod");
