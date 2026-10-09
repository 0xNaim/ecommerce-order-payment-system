-- CheckConstraints
ALTER TABLE "products"
ADD CONSTRAINT "products_price_non_negative"
CHECK ("price" >= 0);

ALTER TABLE "inventory"
ADD CONSTRAINT "inventory_available_non_negative"
CHECK ("availableQuantity" >= 0);

ALTER TABLE "inventory"
ADD CONSTRAINT "inventory_reserved_non_negative"
CHECK ("reservedQuantity" >= 0);

ALTER TABLE "order_items"
ADD CONSTRAINT "order_items_quantity_positive"
CHECK ("quantity" > 0);

ALTER TABLE "order_items"
ADD CONSTRAINT "order_items_unit_price_non_negative"
CHECK ("unitPrice" >= 0);

ALTER TABLE "orders"
ADD CONSTRAINT "orders_total_non_negative"
CHECK ("totalAmount" >= 0);

ALTER TABLE "payments"
ADD CONSTRAINT "payments_amount_positive"
CHECK ("amount" > 0);

ALTER TABLE "inventory_reservations"
ADD CONSTRAINT "reservations_quantity_positive"
CHECK ("quantity" > 0);
