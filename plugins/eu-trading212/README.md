# Trading 212 CSV importer

Install the `eu-trading212` plugin folder or its release ZIP. It accepts Trading 212 Spend and Invest activity CSV exports. It keeps repeated rows and sends the host the statement currency, row locator, action, raw date and amount, and any source ID. Balance is absent because these exports do not provide a running balance.

The `includeAllActivity` option defaults to true. This includes withdrawals, spending cashback, cash interest, supported market/limit/stop orders, and dividends alongside card debits, card credits, and deposits. The manifest declares false as the legacy CLI default, which limits the statement CSV to card transactions and deposits. The separate legacy investment export still includes market buys, cash interest, cashback, and the two legacy dividend variants.

Deposits and withdrawals retain their action evidence for transfer routing in the host. Stock orders and dividends include structured investment evidence. Investment rows without a bank-provided ID use the same derived ID as the historical parser. Unsupported actions and invalid rows appear in diagnostics.
