#!/usr/bin/perl
use strict; use warnings;
my $x = $ARGV[0] // 150;
my $y = $ARGV[1] // 100;
open(my $fh, ">", "/dev/input/event2") or die "Cannot open event2: $!";
binmode($fh);
sub ev { my ($t,$c,$v)=@_; print $fh pack("LLSSl",0,0,$t,$c,$v); }
my $EV_SYN=0; my $EV_KEY=1; my $EV_ABS=3;
my $ABS_MT_SLOT=0x2f; my $ABS_MT_TRACKING_ID=0x39;
my $ABS_MT_POSITION_X=0x35; my $ABS_MT_POSITION_Y=0x36;
my $BTN_TOUCH=0x14a;
ev($EV_ABS,$ABS_MT_SLOT,0);
ev($EV_ABS,$ABS_MT_TRACKING_ID,1);
ev($EV_ABS,$ABS_MT_POSITION_X,$x);
ev($EV_ABS,$ABS_MT_POSITION_Y,$y);
ev($EV_KEY,$BTN_TOUCH,1);
ev($EV_SYN,0,0);
select(undef,undef,undef,0.08);
ev($EV_ABS,$ABS_MT_SLOT,0);
ev($EV_ABS,$ABS_MT_TRACKING_ID,-1);
ev($EV_KEY,$BTN_TOUCH,0);
ev($EV_SYN,0,0);
close($fh);
print "Tapped ($x, $y)\n";
