/*
  Warnings:

  - You are about to drop the column `name` on the `Account` table. All the data in the column will be lost.
  - You are about to drop the column `note` on the `Bill` table. All the data in the column will be lost.
  - Added the required column `nameCipher` to the `Account` table without a default value. This is not possible if the table is not empty.
  - Added the required column `noteCipher` to the `Bill` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Account" DROP COLUMN "name",
ADD COLUMN     "nameCipher" BYTEA NOT NULL,
ADD COLUMN     "nameDekVer" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "Bill" DROP COLUMN "note",
ADD COLUMN     "noteCipher" BYTEA NOT NULL,
ADD COLUMN     "noteDekVer" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "LedgerMember" ADD COLUMN     "dekVersion" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "dekWrapped" BYTEA;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "kdfSalt" BYTEA,
ADD COLUMN     "recoveryHash" BYTEA,
ADD COLUMN     "sm2PrivByPwd" BYTEA,
ADD COLUMN     "sm2PrivByRecovery" BYTEA,
ADD COLUMN     "sm2PubKey" TEXT;
