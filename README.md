# Pagos de Deriv (prueba de una semana, 16–23 de noviembre de 2026)

Cada 5 minutos, lo que paga Deriv por **Sube** y por **Baja** a 15 minutos y a 1 hora en oro, EUR/USD, GBP/USD, USD/JPY, AUD/USD,
US 500, US Tech 100, Wall Street 30 y Bitcoin, con la API pública (sin cuenta y sin operar).

Una línea JSON por mercado y plazo en `AAAA-MM-DD.jsonl`:
`t` hora de la cotización (segundos UNIX) · `s` mercado · `d` plazo en minutos · `sube` / `baja` pago por cada unidad apostada
(0,80 = paga 0,80 además de lo apostado) · `spot` / `st` precio y hora de ese precio · `e` código de error si no hay cotización.

El pago dice qué probabilidad le da Deriv a cada lado: 1 / (1 + pago). Al terminar se compara con lo que pasó de verdad.
