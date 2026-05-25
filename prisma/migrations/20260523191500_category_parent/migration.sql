-- 给 Category 加 parentId 字段，支持二级分类
ALTER TABLE "Category" ADD COLUMN "parentId" TEXT;

ALTER TABLE "Category"
  ADD CONSTRAINT "Category_parentId_fkey"
  FOREIGN KEY ("parentId") REFERENCES "Category"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "Category_parentId_idx" ON "Category"("parentId");
