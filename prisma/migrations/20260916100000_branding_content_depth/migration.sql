-- AlterTable
ALTER TABLE "BusinessBranding" ADD COLUMN     "themeStyle" TEXT NOT NULL DEFAULT 'MODERN',
ADD COLUMN     "heroImageKey" TEXT,
ADD COLUMN     "aboutTitle" TEXT,
ADD COLUMN     "aboutBody" TEXT,
ADD COLUMN     "testimonials" JSONB,
ADD COLUMN     "faqItems" JSONB,
ADD COLUMN     "galleryImageKeys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "socialLinks" JSONB,
ADD COLUMN     "sectionsEnabled" JSONB;
