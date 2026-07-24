# Part 2 — reward points

## Collections

`rewardAccounts`
```js
{ _id: ObjectId, userId: ObjectId, availablePoints: Long, reservedPoints: Long,
  version: Long, createdAt: Date, updatedAt: Date }
```
Index: unique `{ userId: 1 }` — locate and atomically update a user's balance.

`pointLots` — earned points are immutable lots so expiry and FIFO consumption are auditable.
```js
{ _id: ObjectId, userId: ObjectId, cohortMonth: 'YYYY-MM', source: 'project'|'promotion',
  sourceId: String, originalPoints: Long, remainingPoints: Long, earnedAt: Date,
  expiresAt: Date|null, status: 'active'|'expired'|'depleted', createdAt: Date }
```
Indexes: unique `{ source: 1, sourceId: 1, userId: 1 }` prevents duplicate earning; `{ userId: 1, status: 1, expiresAt: 1, earnedAt: 1 }` serves conversion/expiry FIFO scans; `{ cohortMonth: 1, earnedAt: 1 }` supports cohort reporting.

`pointTransactions` — append-only finance journal.
```js
{ _id: ObjectId, userId: ObjectId, cohortMonth: 'YYYY-MM', type: 'earned'|'converted'|'expired',
  points: Long, lotId: ObjectId|null, conversionId: ObjectId|null, occurredAt: Date,
  idempotencyKey: String|null, metadata: Object, createdAt: Date }
```
Indexes: unique sparse `{ userId: 1, idempotencyKey: 1 }` makes writes retry-safe; `{ occurredAt: 1, cohortMonth: 1, userId: 1, type: 1 }` serves the monthly report; `{ lotId: 1 }` is the lot audit trail.

`pointConversions`
```js
{ _id: ObjectId, userId: ObjectId, idempotencyKey: String, points: Long,
  rate: { cashPaisePerPoint: Long, version: String }, cashPaise: Long,
  status: 'reserved'|'credited'|'reversed', createdAt: Date, completedAt: Date|null }
```
Index: unique `{ userId: 1, idempotencyKey: 1 }` prevents duplicate conversions; `{ userId: 1, createdAt: -1 }` serves history/support.

`conversionRates`
```js
{ _id: ObjectId, version: String, cashPaisePerPoint: Long, effectiveFrom: Date, effectiveTo: Date|null, createdAt: Date }
```
Indexes: unique `{ version: 1 }`; `{ effectiveFrom: -1 }` selects the active rate. The conversion stores the selected rate so reports never reinterpret history.

## Monthly finance aggregation

For `start`, `end`, and the requested `month`, aggregate `pointTransactions`:
```js
[
  { $match: { occurredAt: { $gte: start, $lt: end } } },
  { $group: {
    _id: { userId: '$userId', cohortMonth: '$cohortMonth' },
    pointsEarned: { $sum: { $cond: [{ $eq: ['$type', 'earned'] }, '$points', 0] } },
    pointsConverted: { $sum: { $cond: [{ $eq: ['$type', 'converted'] }, '$points', 0] } },
    pointsExpired: { $sum: { $cond: [{ $eq: ['$type', 'expired'] }, '$points', 0] } }
  } },
  { $project: { _id: 0, userId: '$_id.userId', cohortMonth: '$_id.cohortMonth', pointsEarned: 1, pointsConverted: 1, pointsExpired: 1 } },
  { $sort: { cohortMonth: 1, userId: 1 } }
]
```

## Concurrent conversion safety

In one Mongo transaction, create the conversion using its unique idempotency key, select active lots in deterministic expiry/earned order, and conditionally decrement each lot with `{_id, remainingPoints: {$gte: take}}`. Insert matching `converted` journal entries and credit the wallet in the same transaction. If a conditional decrement fails, retry the transaction from fresh state; never rely on a previously read total. The unique conversion key returns the original result for a network retry.
