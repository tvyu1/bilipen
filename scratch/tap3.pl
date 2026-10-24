#!/usr/bin/perl
# 单点触摸协议: BTN_TOUCH + ABS_X/ABS_Y
use strict; use warnings;
my $x=$ARGV[0]//320; my $y=$ARGV[1]//86;
open(my $fh, ">", "/dev/input/event2") or die "open: $!";
binmode($fh);
sub ev { my ($t,$c,$v)=@_; print $fh pack("LLSSl",0,0,$t,$c,$v); }
ev(1,330,1); ev(3,0,$x); ev(3,1,$y); ev(0,0,0);
select(undef,undef,undef,0.08);
ev(1,330,0); ev(0,0,0);
close($fh); print "tap_single($x,$y)\n";
