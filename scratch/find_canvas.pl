use strict;
use warnings;

my $target = pack("V", 0xa6965ba8);
open my $mf, '<', '/proc/717/maps' or die $!;
open my $mem, '<:raw', '/proc/717/mem' or die $!;

while (my $line = <$mf>) {
    chomp $line;
    my @parts = split /\s+/, $line;
    my $perms = $parts[1];
    next unless $perms =~ /r/;
    my ($start, $end) = map { hex($_) } split /-/, $parts[0];
    my $len = $end - $start;
    next if $len > 20 * 1024 * 1024;
    
    seek($mem, $start, 0) or next;
    my $buf;
    my $read_bytes = read($mem, $buf, $len);
    next unless defined $read_bytes && $read_bytes > 0;
    
    my $pos = 0;
    while (($pos = index($buf, $target, $pos)) != -1) {
        my $addr = sprintf("0x%x", $start + $pos);
        print "Found pointer at $addr in $line\n";
        my $s = ($pos >= 16) ? $pos - 16 : 0;
        my $chunk = substr($buf, $s, 48);
        print "   dump: " . unpack("H*", $chunk) . "\n";
        $pos += 4;
    }
}
close $mf;
close $mem;
