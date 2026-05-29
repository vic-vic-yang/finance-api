/*
  Warnings:

  - Added the required column `accountId` to the `AiImport` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "AiImport" ADD COLUMN     "accountId" TEXT NOT NULL;
