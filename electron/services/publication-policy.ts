export const DEFAULT_PUBLICATION_YEAR = 2025

export function isEligiblePublicationYear(year: unknown, minYear = 1): year is number {
  return Number.isInteger(year) && Number(year) >= minYear && Number(year) <= 9999
}

export function getConfiguredMinYear(value: unknown): number {
  const parsed = Number(value)
  return isEligiblePublicationYear(parsed) ? parsed : DEFAULT_PUBLICATION_YEAR
}
