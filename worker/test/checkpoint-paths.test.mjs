import assert from "node:assert/strict";
import { test } from "node:test";
import { foldCase, isDotGitSegment, validPath, validSegment } from "../src/checkpoint-paths.mjs";

test("isDotGitSegment matches .git under git's HFS and NTFS folding (#645)", () => {
	for (const s of [".git", ".GIT", ".Git", ".git.", ".git ", ".git. . ", "git~1", "GIT~1", ".g‌it", ".git﻿", "‎.git", ".gi‪t", ".gi⁯t", ".git::$INDEX_ALLOCATION"]) {
		assert.equal(isDotGitSegment(s), true, `${JSON.stringify(s)} is git's directory on some filesystem`);
		assert.equal(isDotGitSegment(Buffer.from(s, "utf8")), true, "the Buffer spelling folds the same way");
	}
	for (const s of [".gitignore", ".gitattributes", "git", ".git-x", "x.git", "git~2", ".gitmodules", "..git", ""]) {
		assert.equal(isDotGitSegment(s), false, `${JSON.stringify(s)} is an ordinary name`);
	}
	assert.equal(isDotGitSegment(Buffer.from([0x2e, 0x67, 0x69, 0x74, 0xff])), false, "invalid UTF-8 is a bad name, not a dotgit");
});

test("validSegment refuses empty, dot names, slashes, control bytes, invalid UTF-8 and over-long names (#645)", () => {
	for (const s of ["a", "file.txt", "with space", "we\"ird", "back\\slash", "日本語", "é", "x".repeat(255)]) {
		assert.equal(validSegment(s), true, JSON.stringify(s));
	}
	for (const s of ["", ".", "..", "a/b", "nul\0x", "tab\tx", "nl\nx", "esc\x1bx", "del\x7fx", "x".repeat(256), "é".repeat(128)]) {
		assert.equal(validSegment(s), false, JSON.stringify(s));
	}
	assert.equal(validSegment(Buffer.from([0x61, 0xc3])), false, "a truncated UTF-8 sequence");
	assert.equal(validSegment(Buffer.from([0xff, 0xfe])), false, "bytes that are never UTF-8");
	assert.equal(validSegment("..."), true, "three dots is an ordinary (if odd) name");
});

test("validPath: relative, every segment valid and none a dotgit, bounded in bytes and depth (#645)", () => {
	assert.equal(validPath("a/b/c.txt"), true);
	assert.equal(validPath("nested/repo/file"), true);
	for (const p of ["", "/etc/passwd", "a//b", "a/./b", "a/../b", "../x", "a/", "sub/.GIT/config", ".git/config", "x/git~1/y", "a/.git./b", "a/b\0c"]) {
		assert.equal(validPath(p), false, JSON.stringify(p));
	}
	assert.equal(validPath(Array(64).fill("d").join("/")), true, "64 segments is the cap");
	assert.equal(validPath(Array(65).fill("d").join("/")), false, "65 is over it");
	const long = Array(18).fill("x".repeat(240)).join("/");
	assert.ok(Buffer.byteLength(long) > 4096);
	assert.equal(validPath(long), false, "over 4096 bytes");
});

test("foldCase collides the spellings a case-insensitive normalising filesystem collides (#645)", () => {
	assert.equal(foldCase("README.md"), foldCase("readme.MD"));
	assert.equal(foldCase("café"), foldCase("café"), "NFC and NFD of one name");
	assert.equal(foldCase("a‌b"), foldCase("ab"), "an HFS ignorable");
	assert.notEqual(foldCase("a.txt"), foldCase("b.txt"));
	assert.equal(foldCase(Buffer.from("Dir/File")), foldCase("dir/file"));
});
