# Nihaoma BBB Admin Dashboard — User Guide

> For: System Administrators  
> Version: 1.2  

---

## Table of Contents

1. [Hero Stats — Key Metrics](#1-hero-stats--key-metrics)
2. [Summary Strip — Unique Counts](#2-summary-strip--unique-counts)
3. [Live Active Rooms](#3-live-active-rooms)
4. [Analytics — Charts](#4-analytics--charts)
5. [Explore — Data Browser](#5-explore--data-browser)
   - 5.1 [Classes Tab](#51-classes-tab)
   - 5.2 [Teachers Tab](#52-teachers-tab)
   - 5.3 [Students Tab](#53-students-tab)
6. [Sidebar — Leaderboards](#6-sidebar--leaderboards)
7. [Dark Mode](#7-dark-mode)

---

## 1. Hero Stats — Key Metrics

Four large cards at the top of the page showing **all-time cumulative** figures across the entire system.

| Card | Meaning | Notes |
|---|---|---|
| **Total Events** | Total webhook events received from BBB | Includes every event type: room created, join, leave, chat, etc. |
| **Meetings Created** | Total number of BBB meeting sessions created | Increments each time a teacher opens a BBB room |
| **Participants Joined** | Total number of join events | Same student joining the same room 3 times = 3 joins |
| **Participants Left** | Total number of leave events | Counted the same way as Participants Joined |

> **Note:** These figures are cumulative over all time and are not affected by date filters in the tabs below.

---

## 2. Summary Strip — Unique Counts

Four smaller cards below Hero Stats, showing the number of **distinct entities** in the system.

| Card | Meaning |
|---|---|
| **Unique Meetings** | Number of distinct meeting sessions ever recorded |
| **Unique Users** | Number of distinct students ever logged into the system |
| **Unique Classes** | Number of distinct classes in the system |
| **Unique Teachers** | Number of distinct teachers who have ever taught |

> Unlike Hero Stats (which counts occurrences), Summary Strip counts **entities** — each student, teacher, or class is counted only once regardless of how many times they appear.

---

## 3. Live Active Rooms

This section displays **in real time** all BBB meeting rooms currently running on the system.

### Card Information

Each active room appears as a card with a colored left border (unique per room):

| Field | Description |
|---|---|
| **Room name** | Name of the currently running meeting/session |
| **LIVE badge** | Confirms the room is active |
| **Attendee count** (person icon) | Total number of attendees currently in the room |
| **Moderator count** (shield icon) | Number of teachers/moderators currently in the room |
| **Status** (clock icon) | Activity status of the room |

### When No Rooms Are Active

Displays the message: *"No active classes — Meetings appear here in real time when they start."*

### Automatic Updates

The room list is synced from the BBB API and updated via SSE. When a new room starts or ends, the UI updates automatically without a page reload.

---

## 4. Analytics — Charts

The Analytics section provides 6 chart types, switchable via the tabs above.

### Activity Tab

**Chart type:** Line chart  
**Data:** Last 7 days

Three lines are shown:
- **Meetings** (red): Number of rooms created per day
- **Joins** (green): Number of join events per day
- **Leaves** (yellow): Number of leave events per day

> Use this to identify peak days and weekly activity trends.

---

### Peak Hours Tab

**Chart type:** Bar chart  
**Data:** Distribution across 24 hours of the day

Each bar represents one hour slot (00:00–23:00); the height shows the number of joins in that slot. The tallest bar is highlighted in red.

> Use this to identify popular class times and plan server resources.

---

### Duration Tab

**Chart type:** Line chart  
**Data:** Average session duration per day (in minutes)

> Use this to monitor average class length and spot unusually short or long sessions.

---

### Participants Tab

**Chart type:** Doughnut chart  
**Data:** Ratio of Teachers to Students in the system

> Use this to get an overview of the user base composition.

---

### Events Tab

**Chart type:** Doughnut chart  
**Data:** Last 100 webhook events, broken down by type:

| Color | Event type |
|---|---|
| Red | Joins |
| Blue | Leaves |
| Green | Messages (chat) |
| Yellow | Reactions (emoji) |
| Purple | Polls |
| Cyan | Raise hands |

> Use this to understand how actively students interact during sessions.

---

### Workload Tab

**Chart type:** Doughnut chart  
**Data:** Top 10 teachers, each slice showing number of classes they handle

> Use this to assess contribution levels and workload distribution across teachers.

---

## 5. Explore — Data Browser

The Explore section is where you view detail and search data. It contains 3 tabs: **Classes, Teachers, Students**.

The layout is split into two panels:
- **Left (tabContent):** Data table / list
- **Right (detailPanel):** Detail view of the selected item

---

### 5.1 Classes Tab

#### Filters

Located above the table:

| Field | Function |
|---|---|
| **Search class...** | Search by class name or class ID (press Enter or click Filter) |
| **From** | Start date filter (defaults to today) |
| **To** | End date filter (defaults to today) |
| **Filter button** | Apply filters and fetch results from the API |
| **Clear filter button** | Remove all filters and return to the default list |
| **Export Excel button** | Export all currently displayed results to `.xlsx` |

> **Note:** The date filter applies to the class **created date** (`created_at`), not the date of individual meetings.

#### Classes Table

| Column | Meaning |
|---|---|
| **Class** | Class name — click to load detail in the right panel |
| **Created Date** | Date and time the class was first recorded in the system |
| **Teachers** | Number of teachers who have taught this class |
| **Students** | Number of students who have ever joined this class |
| **Joins** | Total join events for this class |
| **Leaves** | Total leave events for this class |
| **Status** | Current status of the class (see table below) |
| **Last Ended** | When the most recent meeting ended, or `-` if none |
| **Detail button** (green) | Export a detailed Excel file for this class |

#### Class Status (Status column)

| Badge | Color | Meaning |
|---|---|---|
| **Live** (pulsing) | Green | The class has a meeting currently running on BBB |
| **Ended** | Gray | At least one past meeting exists and no meeting is currently running |
| **No meetings** | Light gray | No meetings have ever been recorded for this class |

#### Pagination

When results exceed 20 classes, a pagination bar appears below the table with **Prev** / **Next** buttons and the label `Page X / Y · Z classes`.

#### Export Excel — Full List

Click **Export Excel** in the filter bar to export all currently displayed classes:  
`classes_YYYY-MM-DD.xlsx`

Columns: `Class ID, Class Name, Created Date, Teachers, Students, Joins, Leaves`

#### Export Excel — Per-Class Detail

Click the **Detail** button (green) at the end of any row to export a detailed activity file:  
`class_<class name>_YYYY-MM-DD.xlsx`

The file contains one sheet named **Room Activity** with the following columns:

| Column | Meaning |
|---|---|
| **Name** | Participant name |
| **Mod** | Whether the participant is a Moderator (teacher) — Yes / No |
| **Score** | Composite activity score (total interactions) |
| **Talk** | Time spent talking |
| **Webcam** | Time webcam was on |
| **Msgs** | Number of chat messages sent |
| **React** | Number of emoji reactions used |
| **Polls** | Number of poll votes cast |
| **Hands** | Number of times hand was raised |
| **Joined** | Time the participant entered the room |
| **Left** | Time the participant left the room |
| **Dur** | Total time spent in the room |

#### Class Detail Panel (right side)

Clicking a class name loads the detail panel on the right, which shows:

- **Class name** and total join count
- **Metrics:** Teachers, Students, Joins, Leaves
- **Teacher list** (with number of meetings taught)
- **Top Students** (top 6 by participation)
- **Room Activity table:** Detailed per-participant activity (same data as the Detail export)

---

### 5.2 Teachers Tab

#### Teachers Table

| Column | Meaning |
|---|---|
| **Teacher** | Teacher ID/name — click to view detail |
| **Classes** | Number of classes the teacher has taught |
| **Teachers** | Number of co-teachers in those classes |
| **Joins** | Total join events across the teacher's classes |
| **Leaves** | Total leave events across the teacher's classes |

#### Teacher Detail Panel (right side)

- **Avatar** with initials
- **Metrics:** Students, Meetings, Joins, Leaves
- **Class list** the teacher has taught

---

### 5.3 Students Tab

#### Students Table

| Column | Meaning |
|---|---|
| **Student** | Student name — click to view detail |
| **Classes** | Number of classes the student has attended |
| **Teachers** | Number of distinct teachers the student has studied with |
| **Joins** | Total join events |
| **Leaves** | Total leave events |

#### Student Detail Panel (right side)

- **Avatar** with initials
- **Metrics:** Classes, Teachers, Joins, Leaves
- **Related Classes:** List of classes attended
- **Related Teachers:** List of teachers studied with

---

## 6. Sidebar — Leaderboards

The sidebar is fixed on the right side of the screen (sticky) and displays the top 5 entries in three leaderboards.

### Top Classes — Most Active Classes

Ranked by **highest total join count**, showing top 5.

| Field | Meaning |
|---|---|
| Rank (#1–#5) | Position in the leaderboard |
| Class name | Name of the class |
| Sub-text | Number of teachers · number of students |
| Right-side number (red) | Total join count |

---

### Top Teachers — Most Active Teachers

Ranked by **highest total joins across their classes**, showing top 5.

| Field | Meaning |
|---|---|
| Avatar | Teacher initials |
| Teacher name | ID / display name |
| Sub-text | Number of classes · number of students |
| Right-side number (yellow) | Total join count across the teacher's classes |

---

### Top Students — Most Dedicated Students

Ranked by **number of distinct classes attended**, showing top 5.

| Field | Meaning |
|---|---|
| Avatar | Student initials |
| Student name | Display name |
| Sub-text | Total joins · number of teachers studied with |
| Right-side number (green) | Number of classes attended |

---

## 7. Dark Mode

Click the **sun / moon icon** in the top-right corner of the header to toggle between themes.

- **Light mode** (default): White/soft pink background, suited for daytime use
- **Dark mode**: Dark background, easier on the eyes for evening work

The preference is **saved in the browser** (localStorage) and persists across page reloads and browser restarts.

