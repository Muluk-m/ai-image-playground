CREATE TABLE billing_order_request_aliases (
 user_id text NOT NULL REFERENCES users(id),
 request_id text NOT NULL,
 order_id text NOT NULL REFERENCES billing_purchase_orders(id),
 PRIMARY KEY (user_id, request_id)
);
