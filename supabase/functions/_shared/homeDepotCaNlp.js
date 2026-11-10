// Home Depot Canada's NLP rule, shared by its promotion file (homeDepotCaPromoFill)
// and Price Alignment (2026-10-20): the NLP workbook (kitchen sinks, sheet D29K)
// takes a product only when its NLP is at least 5% under the WAS price — its
// J formula is ROUNDDOWN((WAS - NLP) / WAS, 4) (user, 2026-10-16). A sink under
// the minimum is left out of the file, so Home Depot keeps it at its WAS price.
export const NLP_MIN_DISCOUNT = 0.05;
export const nlpDiscount = (was, nlp) => Math.floor(((was - nlp) / was) * 10000 + 1e-9) / 10000;

// Home Depot Canada files sinks by family: its "Kitchen Sinks" sheet also
// takes the bar / prep, laundry and outdoor sinks (user rule 2026-09-28).
export const CATEGORY_FAMILY = { kitchen_sink: ['kitchen_sink', 'bar_prep_sink', 'laundry_sink', 'outdoor_sink'] };
export const NLP_CATEGORIES = new Set(CATEGORY_FAMILY.kitchen_sink);
