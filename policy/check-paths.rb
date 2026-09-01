#!/usr/bin/env ruby
# Layer B evaluator for the postman-cs path policy (see policy/README.md).
# Usage: ruby policy/check-paths.rb <path-policy.patterns.json> <changed.jsonl>
# changed.jsonl holds one JSON object per line with "filename" and "status" as returned by
# GET /repos/{owner}/{repo}/pulls/{n}/files. A path is blocked when any deny pattern matches and
# no allow pattern matches, using the same fnmatch flags GitHub applies to push rules.
require 'json'

patterns_path, changed_path = ARGV
abort 'usage: check-paths.rb <path-policy.patterns.json> <changed.jsonl>' unless patterns_path && changed_path

policy = JSON.parse(File.read(patterns_path))
deny  = policy.fetch('deny')
allow = policy.fetch('allow')

FLAGS = File::FNM_PATHNAME | File::FNM_DOTMATCH | File::FNM_CASEFOLD
EVALUATED_STATUSES = %w[added modified renamed copied changed].freeze
API_CAP = 3000

match = ->(pats, path) { pats.any? { |p| File.fnmatch?(p, path, FLAGS) } }

total = 0
skipped = 0
blocked = []
File.foreach(changed_path) do |line|
  next if line.strip.empty?

  entry = JSON.parse(line)
  total += 1
  unless EVALUATED_STATUSES.include?(entry['status'])
    skipped += 1
    next
  end
  path = entry.fetch('filename')
  blocked << [path, entry['status']] if match.(deny, path) && !match.(allow, path)
end

if total >= API_CAP
  puts "::error::changed file list has #{total} entries (>= #{API_CAP} API cap); failing closed"
  exit 1
end

blocked.each { |path, status| puts "::error::blocked path: #{path} (#{status})" }
puts "path-policy: #{blocked.size} blocked path(s); #{total} changed entries, #{skipped} skipped (removed/unchanged)"
exit(blocked.empty? ? 0 : 1)
