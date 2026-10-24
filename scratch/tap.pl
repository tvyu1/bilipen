#!/usr/bin/perl
use strict;
use warnings;

my $x = $ARGV[0] // 48;
my $y = $ARGV[1] // 75;

open(my $fh, ">", "/dev/input/event2") or die "Cannot open event2: $!";
binmode($fh);

sub ev {
    my ($t, $c, $v) = @_;
    print $fh pack("LLSSl", 0, 0, $t, $c, $v);
}

ev(3, 57, 1);
ev(3, 53, $x);
ev(3, 54, $y);
ev(1, 330, 1);
ev(0, 0, 0);
$fh->flush();

select(undef, undef, undef, 0.05);

ev(3, 57, -1);
ev(1, 330, 0);
ev(0, 0, 0);
$fh->flush();
close($fh);

print "Tapped ($x, $y)\n";
