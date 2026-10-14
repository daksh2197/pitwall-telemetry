# Why this matters outside the garage

A race car makes thousands of readings a second. The engineers who use them are not at the car. They are at the pit wall or in a factory far away, and the link between them is a radio that fails at the worst moments.

## The problem

When the link drops, there are two bad outcomes. The screen quietly keeps showing old numbers as if they were live, or it shows nothing and the data from the gap is gone. Both lead to decisions made on data that is not what it seems.

## What this build shows

- The screen says when data is stale, not just when it is wrong.
- The gap is measured: how long it lasted and how long the catch-up took.
- Loss is counted. In the default 5 s outage run nothing is lost. With a small buffer, 649 of 8,800 frames are, and the page says so.
- The trade-off is a number, not an opinion: a smaller buffer gets back to live sooner and keeps less history.

## Who has this problem

Anyone who streams sensor data over a weak link: motorsport, test rigs, remote machinery, field vehicles, drones, anything on a boat or a mine site. The ideas here (sequence numbers, bounded buffers, honest loss counts, staleness shown to the user) carry over.

## What this is not

It is a simulation. It uses no real car data, no real team's data and no real radio. It has no affiliation with any racing series or team. It shows how I think about the problem and what I can build and test in a short time.

## What it would take to go further

Real clock sync, error checking, support for larger CAN FD frames, and a test against a real radio. Those are listed in the README under What's next.
