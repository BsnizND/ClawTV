# ClawTV Product Spec

## Summary

ClawTV is a playback system for people who want a TV-like experience without a TV-like interface.

Instead of opening an app and browsing manually, the viewer lands in a thin receiver while a server and command surface decide what should play. That command surface can be a human operator, a script, or an agent.

## Product Goal

Build a self-hosted system where:

- the screen is simple
- playback is reliable
- control happens off-screen
- the system can express curation, continuity, and intent

The experience should feel closer to a programmed channel than an on-screen media browser.

## Why It Matters

Modern TV interfaces are often cluttered, menu-heavy, and hard to use in low-friction or accessibility-focused contexts. ClawTV explores the opposite:

- turn on the display
- land directly in a receiver
- ask for something naturally or issue a simple command
- let the system handle the queue and playback state

## Core Principles

- Minimal TV-side interaction
- Server-owned playback state
- Thin receiver clients
- Human-readable control surfaces
- Agent-friendly command vocabulary
- Accessibility and low cognitive load over feature bloat

## Included In V1

- A server app that owns queue and playback state
- A receiver UI for fullscreen playback
- A CLI for testing and control
- A synced local catalog backed by Plex metadata
- Commands for play-by-title, latest-episode lookup, shuffle, and transport control
- Optional agent integration through a reusable skill

## Explicit Non-Goals

- A full streaming platform
- Rich on-TV browsing and settings UIs
- Multi-user account systems
- Heavy recommendation infrastructure
- A second client-side source of truth for playback

## User Story

The viewer turns on the display and lands in ClawTV.

The receiver shows a branded idle or ready state. A human or agent then issues requests such as:

- play a specific movie
- play the latest episode of a series
- shuffle a show or collection
- find something related to a topic or mood

ClawTV resolves that request against the local catalog, updates the queue, and begins playback on the active receiver.

## System Shape

### 1. Server

The server is the playback authority.

Responsibilities:

- maintain sessions
- resolve commands into queue updates
- expose APIs for status, catalog queries, and transport control
- preserve playback position and command history

### 2. Receiver

The receiver should remain thin.

Responsibilities:

- show idle, loading, playing, paused, and error states
- play the assigned stream
- report local playback state back to the server

The receiver should not browse the library or decide what to play.

### 3. Control Surface

The control surface can be a CLI, script, or agent skill.

Responsibilities:

- accept intent from a human or automation layer
- translate that intent into structured ClawTV commands
- keep the command vocabulary consistent

### 4. Catalog

The catalog tells ClawTV what exists and how it can be resolved.

Responsibilities:

- title lookup
- series and episode lookup
- recency
- collection membership
- metadata-backed search

## Success Criteria

The project direction is validated when someone can:

- turn on the display
- land directly in ClawTV
- request content without on-screen browsing
- get stable, low-friction playback from a server-controlled queue
